/*
 * Vencord, a Discord client mod
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { definePluginSettings } from "@api/Settings";
import { UserAreaButton, UserAreaRenderProps } from "@api/UserArea";
import { Logger } from "@utils/Logger";
import definePlugin, { OptionType } from "@utils/types";
import { ChannelActions, ChannelStore, PermissionStore, PermissionsBits, React, RestAPI, SelectedChannelStore, showToast, Toasts, UserStore, VoiceStateStore } from "@webpack/common";
import { RulesEditor } from "./rulesEditor";

export type Rule = {
    guildId: string;
    userId: string;
    action: "leave" | "disconnect" | "move";
    channelId?: string;
};
type VoiceState = { userId: string; channelId?: string | null; };

const logger = new Logger("VoiceArrivalActions");
const snowflake = /^\d{17,20}$/;

export function parseRules(text: string): Rule[] {
    const rules: unknown = JSON.parse(text);
    if (!Array.isArray(rules)) throw new Error("Saved rules must be a list.");
    const seen = new Set<string>();
    for (const rule of rules) {
        if (!rule || typeof rule !== "object"
            || typeof rule.guildId !== "string" || (rule.guildId !== "*" && !snowflake.test(rule.guildId))
            || typeof rule.userId !== "string" || !snowflake.test(rule.userId)
            || !["leave", "disconnect", "move"].includes(rule.action))
            throw new Error("Choose a server, enter a valid user ID and select an action for every rule.");
        if (rule.action === "move" && (typeof rule.channelId !== "string" || !snowflake.test(rule.channelId)))
            throw new Error("Choose a destination voice channel for every move rule.");
        if (rule.guildId === "*" && rule.action === "move")
            throw new Error("Use a server-specific rule for moving members. All servers supports leaving or disconnecting.");
        const key = `${rule.guildId}:${rule.userId}`;
        if (seen.has(key)) throw new Error("Only one rule per user per server is allowed.");
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
        onChange() {
            generation++;
            pending.forEach(clearTimeout);
            pending.clear();
            busy = false;
            if (active) snapshot();
        }
    },
    rules: {
        type: OptionType.COMPONENT,
        displayName: "Server rules",
        component: RulesEditor,
        default: "[]",
        onChange() {
            generation++;
            pending.forEach(clearTimeout);
            pending.clear();
            busy = false;
            if (active) snapshot();
        }
    }
});

let active = false;
let generation = 0;
let busy = false;
let previousChannel: string | null = null;
let previousMembers = new Set<string>();
const pending = new Set<ReturnType<typeof setTimeout>>();

function members(channelId: string): Set<string> {
    const states = VoiceStateStore.getVoiceStatesForChannel(channelId) as Record<string, VoiceState>;
    return new Set(Object.values(states ?? {}).map(state => state.userId));
}

function notify(message: string, failure = false) {
    showToast(`VoiceArrivalActions: ${message}`, failure ? Toasts.Type.FAILURE : Toasts.Type.MESSAGE);
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

    if (!PermissionStore.can(PermissionsBits.ADMINISTRATOR, source)) {
        notify("Administrator permission is required for group actions. Action cancelled.", true);
        return;
    }
    if (rule.action === "move") {
        const destination = ChannelStore.getChannel(rule.channelId!);
        if (!destination || destination.guild_id !== rule.guildId || destination.type !== 2
            || destination.id === sourceId
            || !PermissionStore.can(PermissionsBits.VIEW_CHANNEL, destination)
            || !PermissionStore.can(PermissionsBits.CONNECT, destination)) {
            notify("Choose a different accessible voice channel on the same server.", true);
            return;
        }
    }

    let completed = 0;
    // Move/disconnect ourselves last so the source-channel checks remain valid.
    const others = targets.filter(id => id !== me && id !== rule.userId);
    for (const id of others) {
        if (!stillValid()) return;
        if (!members(sourceId).has(id)) continue;
        if (!PermissionStore.can(PermissionsBits.ADMINISTRATOR, source)) {
            notify("Administrator permission was lost. Action stopped.", true);
            return;
        }
        try {
            await RestAPI.patch({
                url: `/guilds/${source.guild_id}/members/${id}`,
                body: { channel_id: rule.action === "move" ? rule.channelId : null }
            });
            completed++;
        } catch (error) {
            logger.error("Failed to update voice member", error);
            notify(`Stopped after ${completed} members: Discord rejected the request. Check permissions and channel limits.`, true);
            return;
        }
    }
    if (!stillValid()) return;
    ChannelActions.selectVoiceChannel(rule.action === "move" ? rule.channelId! : null);
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
    const source = ChannelStore.getChannel(channelId);
    if (!source?.guild_id) return;
    let rules: Rule[];
    try { rules = parseRules(settings.store.rules); }
    catch (error) { logger.error("Invalid rules", error); return; }
    const matchesArrival = (r: Rule) => r.userId !== me && current.has(r.userId) && !before.has(r.userId);
    // A server-specific rule overrides the global rule for the same user.
    const rule = rules.find(r => r.guildId === source.guild_id && matchesArrival(r))
        ?? rules.find(r => r.guildId === "*" && matchesArrival(r));
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
        previousMembers.clear();
    }
});
