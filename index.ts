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

import { RulesEditor } from "./rulesEditor";

export type Rule = {
    guildId: string;
    userId: string;
    action: "leave" | "disconnect" | "move";
    channelId?: string;
};
type VoiceState = { userId: string; channelId?: string | null; };

export const GUILD_VOICE = 2;
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
    }
});

let active = false;
let generation = 0;
let busy = false;
let previousChannel: string | null = null;
let previousMembers = new Set<string>();
const pending = new Set<ReturnType<typeof setTimeout>>();

function reset() {
    generation++;
    pending.forEach(clearTimeout);
    pending.clear();
    busy = false;
    if (active) snapshot();
}

function members(channelId: string): Set<string> {
    const states = VoiceStateStore.getVoiceStatesForChannel(channelId) as Record<string, VoiceState>;
    return new Set(Object.values(states ?? {}).map(state => state.userId));
}

function notify(message: string, failure = false) {
    showToast(`VoiceArrivalActions: ${message}`, failure ? "failure" : "message");
}

async function act(rule: Rule, sourceId: string, targets: string[], token: number) {
    const me = UserStore.getCurrentUser()?.id;
    const stillValid = () => active && settings.store.armed && generation === token
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

    if (!PermissionStore.can(PermissionsBits.MOVE_MEMBERS, source)) {
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
    if (!settings.store.armed || !channelId || !sameChannel || !me || !before.has(me) || !current.has(me) || busy) return;
    const arrivals = [...current].filter(id => id !== me && !before.has(id));
    if (!arrivals.length) return;
    const source = ChannelStore.getChannel(channelId);
    if (!source?.guild_id) return;
    let rules: Rule[];
    try { rules = parseRules(settings.store.rules); }
    catch (error) { logger.error("Invalid rules", error); return; }
    // A server-specific rule overrides the global rule for the same user.
    const rule = rules.find(r => r.guildId === source.guild_id && arrivals.includes(r.userId))
        ?? rules.find(r => r.guildId === "*" && arrivals.includes(r.userId));
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

function EscapeButton({ iconForeground, hideTooltips, nameplate }: UserAreaRenderProps) {
    const { armed } = settings.use(["armed"]);
    const label = `Emergency exit: ${armed ? "on" : "off"}`;
    return React.createElement(UserAreaButton, {
        tooltipText: hideTooltips ? undefined : label,
        "aria-label": label,
        icon: React.createElement(EscapeIcon, { className: iconForeground }),
        role: "switch",
        "aria-checked": armed,
        redGlow: armed,
        plated: nameplate != null,
        onClick: () => {
            settings.store.armed = !settings.store.armed;
            notify(settings.store.armed ? "Emergency exit enabled." : "Emergency exit disabled.");
        }
    });
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
        VoiceStateStore.addChangeListener(onVoiceChange);
        SelectedChannelStore.addChangeListener(onVoiceChange);
    },
    stop() {
        active = false;
        generation++;
        VoiceStateStore.removeChangeListener(onVoiceChange);
        SelectedChannelStore.removeChangeListener(onVoiceChange);
        pending.forEach(clearTimeout);
        pending.clear();
        busy = false;
        previousChannel = null;
        previousMembers = new Set();
    }
});
