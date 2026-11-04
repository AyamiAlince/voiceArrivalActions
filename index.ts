/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { definePluginSettings } from "@api/Settings";
import { UserAreaButton, UserAreaRenderProps } from "@api/UserArea";
import { Logger } from "@utils/Logger";
import { sleep } from "@utils/misc";
import definePlugin, { OptionType } from "@utils/types";
import { ChannelActions, ChannelStore, PermissionsBits, PermissionStore, React, RestAPI, SelectedChannelStore, showToast, UserStore, VoiceStateStore } from "@webpack/common";

import { openPauseMenu } from "./pauseMenu";
import { RulesEditor } from "./rulesEditor";

export type Rule = {
    guildId: string;
    userId: string;
    action: "leave" | "disconnect" | "move";
    channelId?: string;
};
type VoiceState = { userId: string; channelId?: string | null; };

export const GUILD_VOICE = 2;
/** Stored as the pause end for rules paused until the user resumes them. */
export const PAUSE_FOREVER = 0;
const MAX_TIMEOUT = 2 ** 31 - 1;
const MAX_RATE_LIMIT_RETRIES = 3;
const logger = new Logger("VoiceArrivalActions");
const snowflake = /^\d{17,20}$/;

export function isSnowflake(value: unknown): value is string {
    return typeof value === "string" && snowflake.test(value);
}

export function parseRules(text: string): Rule[] {
    const rules: unknown = JSON.parse(text);
    if (!Array.isArray(rules)) throw new Error("Saved rules must be a list.");
    const seen = new Set<string>();
    for (const rule of rules) {
        if (!rule || typeof rule !== "object"
            || typeof rule.guildId !== "string" || (rule.guildId !== "*" && !isSnowflake(rule.guildId))
            || !isSnowflake(rule.userId)
            || !["leave", "disconnect", "move"].includes(rule.action))
            throw new Error("Choose a person, a server and an action for every rule.");
        if (rule.action === "move" && !isSnowflake(rule.channelId))
            throw new Error("Choose a destination voice channel for every move rule.");
        if (rule.guildId === "*" && rule.action === "move")
            throw new Error("Moving members needs a specific server. Rules for all servers can only leave or disconnect.");
        const key = `${rule.guildId}:${rule.userId}`;
        if (seen.has(key)) throw new Error("Only one rule per person per server is allowed.");
        seen.add(key);
    }
    return rules as Rule[];
}

export const settings = definePluginSettings({
    armed: {
        type: OptionType.BOOLEAN,
        displayName: "Emergency exit",
        description: "Automatically run your rules when a watched user joins your voice channel.",
        default: false,
        hidden: true,
        onChange: reset
    },
    rules: {
        type: OptionType.COMPONENT,
        displayName: "Server rules",
        component: RulesEditor,
        default: "[]",
        onChange: reset
    },
    pausedUntil: {
        type: OptionType.NUMBER,
        description: "Time (ms since epoch) until which all rules are paused. 0 means not paused.",
        default: 0,
        hidden: true
    },
    pausedRules: {
        type: OptionType.STRING,
        description: "JSON map of rule keys to the time their pause ends (0 = until resumed).",
        default: "{}",
        hidden: true
    }
});

export function ruleKey(rule: Pick<Rule, "guildId" | "userId">) {
    return `${rule.guildId}:${rule.userId}`;
}

export function readPausedRules(text: string = settings.store.pausedRules): Record<string, number> {
    try {
        const value: unknown = JSON.parse(text);
        if (value && typeof value === "object" && !Array.isArray(value))
            return Object.fromEntries(Object.entries(value).filter(([, until]) => typeof until === "number" && Number.isFinite(until)));
    } catch { }
    return {};
}

/** Returns when the rule's pause ends (PAUSE_FOREVER if it has no end), or null if the rule is active. */
export function rulePausedUntil(key: string, paused = readPausedRules(), now = Date.now()): number | null {
    const until = paused[key];
    if (until === undefined) return null;
    return until === PAUSE_FOREVER || until > now ? until : null;
}

export function isPausedGlobally(now = Date.now()) {
    return settings.store.armed && settings.store.pausedUntil > now;
}

export function formatUntil(until: number) {
    if (until === PAUSE_FOREVER) return "until you resume it";
    const date = new Date(until);
    const time = date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    return date.toDateString() === new Date().toDateString()
        ? `until ${time}`
        : `until ${date.toLocaleDateString([], { weekday: "short", day: "numeric", month: "short" })} ${time}`;
}

function writePausedRules(paused: Record<string, number>) {
    settings.store.pausedRules = JSON.stringify(paused);
    onPauseChange();
}

export function pauseRule(key: string, until: number) {
    writePausedRules({ ...readPausedRules(), [key]: until });
    notify(`Rule paused ${formatUntil(until)}.`);
}

export function resumeRule(key: string) {
    const paused = readPausedRules();
    delete paused[key];
    writePausedRules(paused);
    notify("Rule resumed.");
}

/** Drops pauses of rules that no longer exist. */
export function prunePausedRules(keys: string[]) {
    const paused = readPausedRules();
    const kept = Object.fromEntries(Object.entries(paused).filter(([key]) => keys.includes(key)));
    if (Object.keys(kept).length !== Object.keys(paused).length) writePausedRules(kept);
}

export function pauseAll(ms: number) {
    settings.store.pausedUntil = Date.now() + ms;
    onPauseChange();
    notify(`All rules paused ${formatUntil(settings.store.pausedUntil)}.`);
}

export function resumeAll() {
    settings.store.pausedUntil = 0;
    onPauseChange();
    notify("Pause ended. Emergency exit is on.");
}

export function setArmed(armed: boolean) {
    settings.store.armed = armed;
    settings.store.pausedUntil = 0;
    onPauseChange();
    notify(armed ? "Emergency exit enabled." : "Emergency exit disabled.");
}

let active = false;
let generation = 0;
let busy = false;
let previousChannel: string | null = null;
let previousMembers = new Set<string>();
let expiryTimer: ReturnType<typeof setTimeout> | undefined;
const pending = new Set<ReturnType<typeof setTimeout>>();

function reset() {
    generation++;
    pending.forEach(clearTimeout);
    pending.clear();
    busy = false;
    if (active) snapshot();
}

function onPauseChange() {
    reset();
    scheduleExpiry();
}

/** Clears pauses that have ended and wakes up again when the next one ends. */
function scheduleExpiry() {
    clearTimeout(expiryTimer);
    expiryTimer = undefined;
    if (!active) return;
    const now = Date.now();
    const { pausedUntil } = settings.store;
    if (pausedUntil !== 0 && pausedUntil <= now) {
        settings.store.pausedUntil = 0;
        if (settings.store.armed) notify("Pause ended. Emergency exit is on.");
    }
    const paused = readPausedRules();
    const expired = Object.keys(paused).filter(key => rulePausedUntil(key, paused, now) === null);
    if (expired.length) {
        expired.forEach(key => delete paused[key]);
        settings.store.pausedRules = JSON.stringify(paused);
        reset();
    }
    const ends = [settings.store.pausedUntil, ...Object.values(paused)].filter(until => until > now);
    if (ends.length) expiryTimer = setTimeout(scheduleExpiry, Math.min(Math.min(...ends) - now + 50, MAX_TIMEOUT));
}

function members(channelId: string): Set<string> {
    const states = VoiceStateStore.getVoiceStatesForChannel(channelId) as Record<string, VoiceState>;
    return new Set(Object.values(states ?? {}).map(state => state.userId));
}

function notify(message: string, failure = false) {
    showToast({ text: `VoiceArrivalActions: ${message}`, variant: failure ? "critical" : "default" });
}

async function act(rule: Rule, sourceId: string, targets: string[], token: number) {
    const me = UserStore.getCurrentUser()?.id;
    const stillValid = () => active && settings.store.armed && generation === token
        && !isPausedGlobally() && rulePausedUntil(ruleKey(rule)) === null
        && SelectedChannelStore.getVoiceChannelId() === sourceId
        && members(sourceId).has(rule.userId);
    if (!me || !stillValid()) return;
    const source = ChannelStore.getChannel(sourceId);
    if (!source || !source.guild_id || (rule.guildId !== "*" && source.guild_id !== rule.guildId)) return;

    if (rule.action === "leave") {
        ChannelActions.selectVoiceChannel(null);
        notify("You left the voice channel.");
        return;
    }

    // Leaving matters more than disconnecting others, so a disconnect rule still gets you out.
    const leaveAlone = (reason: string) => {
        if (rule.action !== "disconnect" || !stillValid()) return false;
        ChannelActions.selectVoiceChannel(null);
        notify(`${reason} You left the voice channel on your own.`, true);
        return true;
    };

    if (!PermissionStore.can(PermissionsBits.MOVE_MEMBERS, source)) {
        if (!leaveAlone("You don't have the Move Members permission in this channel."))
            notify("You need the Move Members permission in this channel. Action cancelled.", true);
        return;
    }
    const destinationId = rule.action === "move" ? rule.channelId ?? null : null;
    if (rule.action === "move") {
        const destination = destinationId ? ChannelStore.getChannel(destinationId) : null;
        if (!destination || destination.guild_id !== source.guild_id || destination.type !== GUILD_VOICE
            || destination.id === sourceId
            || !PermissionStore.can(PermissionsBits.VIEW_CHANNEL, destination)
            || !PermissionStore.can(PermissionsBits.CONNECT, destination)
            || !PermissionStore.can(PermissionsBits.MOVE_MEMBERS, destination)) {
            notify("Choose a different voice channel on the same server that you can join and move members into.", true);
            return;
        }
    }

    let completed = 0;
    // Move/disconnect ourselves last so the source-channel checks remain valid.
    const others = targets.filter(id => id !== me && id !== rule.userId);
    for (const id of others) {
        for (let attempt = 0; ; attempt++) {
            if (!stillValid()) return;
            if (!members(sourceId).has(id)) break;
            if (!PermissionStore.can(PermissionsBits.MOVE_MEMBERS, source)) {
                if (!leaveAlone(`The Move Members permission was lost after ${completed} members.`))
                    notify("The Move Members permission was lost. Action stopped.", true);
                return;
            }
            try {
                await RestAPI.patch({
                    url: `/guilds/${source.guild_id}/members/${id}`,
                    body: { channel_id: destinationId }
                });
                completed++;
                break;
            } catch (error) {
                const { status, body } = error as { status?: number; body?: { retry_after?: number; }; };
                if (status === 429 && attempt < MAX_RATE_LIMIT_RETRIES) {
                    await sleep((body?.retry_after ?? 1) * 1000 + 100);
                    continue;
                }
                logger.error("Failed to update voice member", error);
                if (!leaveAlone(`Discord rejected disconnecting members after ${completed}.`))
                    notify(`Stopped after ${completed} members: Discord rejected the request. Check permissions and channel limits.`, true);
                return;
            }
        }
    }
    if (!stillValid()) return;
    ChannelActions.selectVoiceChannel(destinationId);
    notify(rule.action === "move" ? `Moved ${completed} members; joining the destination.` : `Disconnected ${completed} members; you left.`);
}

function snapshot() {
    previousChannel = SelectedChannelStore.getVoiceChannelId() ?? null;
    previousMembers = previousChannel ? members(previousChannel) : new Set();
}

function onVoiceChange() {
    if (!active) return;
    const channelId = SelectedChannelStore.getVoiceChannelId() ?? null;
    const current = channelId ? members(channelId) : new Set<string>();
    const before = previousMembers;
    const sameChannel = previousChannel === channelId;
    previousChannel = channelId;
    previousMembers = current;
    const me = UserStore.getCurrentUser()?.id;
    // Ignore startup, reconnects and our own entry into an occupied channel.
    if (!settings.store.armed || isPausedGlobally() || !channelId || !sameChannel || !me || !before.has(me) || !current.has(me) || busy) return;
    const arrivals = [...current].filter(id => id !== me && !before.has(id));
    if (!arrivals.length) return;
    const source = ChannelStore.getChannel(channelId);
    if (!source?.guild_id) return;
    let rules: Rule[];
    try { rules = parseRules(settings.store.rules); }
    catch (error) { logger.error("Invalid rules", error); return; }
    // A server-specific rule overrides the global rule for the same user, even while it is paused.
    const effective = (r: Rule) => r.guildId === source.guild_id
        || (r.guildId === "*" && !rules.some(s => s.guildId === source.guild_id && s.userId === r.userId));
    const paused = readPausedRules();
    const now = Date.now();
    const candidates = rules.filter(r => arrivals.includes(r.userId) && effective(r) && rulePausedUntil(ruleKey(r), paused, now) === null);
    const rule = candidates.find(r => r.guildId !== "*") ?? candidates[0];
    if (!rule) return;
    busy = true;
    const token = generation;
    // Store listeners run during Flux dispatch; perform actions afterwards.
    const timer = setTimeout(() => {
        pending.delete(timer);
        void act(rule, channelId, [...current], token)
            .catch(error => {
                logger.error("Voice action failed", error);
                notify("Action failed. See the console for details.", true);
            })
            .finally(() => { if (generation === token) busy = false; });
    }, 0);
    pending.add(timer);
}

function EscapeIcon({ className }: { className?: string; }) {
    return React.createElement("svg", {
        className, width: 20, height: 20, viewBox: "0 0 24 24",
        fill: "none", stroke: "currentColor", strokeWidth: 2, "aria-hidden": true
    }, React.createElement("path", {
        d: "M10 4H4v16h6M8 12h13m-5-5 5 5-5 5"
    }));
}

function PauseIcon({ className }: { className?: string; }) {
    return React.createElement("svg", {
        className, width: 20, height: 20, viewBox: "0 0 24 24",
        fill: "none", stroke: "currentColor", strokeWidth: 2, "aria-hidden": true
    }, React.createElement("path", {
        d: "M10 4H4v16h6M15 8v8m5-8v8"
    }));
}

function EscapeButton({ iconForeground, hideTooltips, nameplate }: UserAreaRenderProps) {
    const { armed, pausedUntil, pausedRules, rules: saved } = settings.use(["armed", "pausedUntil", "pausedRules", "rules"]);
    const now = Date.now();
    const paused = armed && pausedUntil > now;
    let rules: Rule[] = [];
    try { rules = parseRules(saved); } catch { }
    const pausedMap = readPausedRules(pausedRules);
    const pausedCount = rules.filter(rule => rulePausedUntil(ruleKey(rule), pausedMap, now) !== null).length;
    const state = !armed ? "off"
        : paused ? `paused ${formatUntil(pausedUntil)}`
            : pausedCount ? `on, ${pausedCount} of ${rules.length} rules paused` : "on";
    const label = `Emergency exit: ${state}`;
    const button = React.createElement(UserAreaButton, {
        tooltipText: hideTooltips ? undefined : `${label}. Right-click to pause rules.`,
        "aria-label": label,
        icon: React.createElement(paused ? PauseIcon : EscapeIcon, { className: iconForeground }),
        role: "switch",
        "aria-checked": armed && !paused,
        redGlow: armed && !paused,
        plated: nameplate != null,
        onClick: () => paused ? resumeAll() : setArmed(!settings.store.armed)
    });
    // The wrapper uses display: contents, so it does not affect the user area layout.
    return React.createElement("span", { className: "vc-vaa-menu-anchor", onContextMenu: openPauseMenu }, button);
}

export default definePlugin({
    name: "VoiceArrivalActions",
    description: "Per-server voice actions when a specified user joins your current voice channel.",
    authors: [{ name: "AyamiAlince", id: 863738240753074196n }],
    dependencies: ["UserAreaAPI"],
    userAreaButton: { icon: EscapeIcon, render: EscapeButton },
    settings,
    start() {
        generation++;
        busy = false;
        snapshot();
        active = true;
        scheduleExpiry();
        VoiceStateStore.addChangeListener(onVoiceChange);
        SelectedChannelStore.addChangeListener(onVoiceChange);
    },
    stop() {
        active = false;
        generation++;
        clearTimeout(expiryTimer);
        expiryTimer = undefined;
        VoiceStateStore.removeChangeListener(onVoiceChange);
        SelectedChannelStore.removeChangeListener(onVoiceChange);
        pending.forEach(clearTimeout);
        pending.clear();
        busy = false;
        previousChannel = null;
        previousMembers = new Set();
    }
});
