/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { ContextMenuApi, GuildStore, Menu, React, UserStore } from "@webpack/common";
import type { MouseEvent } from "react";

import { formatUntil, parseRules, PAUSE_FOREVER, pauseAll, pauseRule, readPausedRules, resumeAll, resumeRule, Rule, ruleKey, rulePausedUntil, setArmed, settings } from ".";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const MENU_KEYS: ("armed" | "pausedUntil" | "pausedRules" | "rules")[] = ["armed", "pausedUntil", "pausedRules", "rules"];

export const PAUSE_ALL_OPTIONS = [
    { label: "For 15 minutes", ms: 15 * MINUTE },
    { label: "For 1 hour", ms: HOUR },
    { label: "For 3 hours", ms: 3 * HOUR },
    { label: "For 8 hours", ms: 8 * HOUR }
];

export const PAUSE_RULE_OPTIONS: { label: string; ms: number | null; }[] = [
    { label: "For 1 hour", ms: HOUR },
    { label: "For 8 hours", ms: 8 * HOUR },
    { label: "For 24 hours", ms: 24 * HOUR },
    { label: "Until I turn it back on", ms: null }
];

const menuId = (key: string) => key.replace(/[^\w-]/g, "_");

export function ruleLabel(rule: Rule) {
    const user = UserStore.getUser(rule.userId);
    const name = user ? user.globalName || user.username : rule.userId;
    const server = rule.guildId === "*" ? "All servers" : GuildStore.getGuild(rule.guildId)?.name ?? "Unavailable server";
    return `${name} · ${server}`;
}

function pauseItems(key: string) {
    const h = React.createElement;
    return PAUSE_RULE_OPTIONS.map(option => h(Menu.MenuItem, {
        id: `vc-vaa-pause-${menuId(key)}-${option.ms ?? "forever"}`,
        label: option.label,
        action: () => pauseRule(key, option.ms === null ? PAUSE_FOREVER : Date.now() + option.ms)
    }));
}

function pauseAllItems() {
    const h = React.createElement;
    return PAUSE_ALL_OPTIONS.map(option => h(Menu.MenuItem, {
        id: `vc-vaa-pause-all-${option.ms}`,
        label: option.label,
        action: () => pauseAll(option.ms)
    }));
}

function PauseMenu({ onClose }: { onClose: () => void; }) {
    const h = React.createElement;
    const { armed, pausedUntil, pausedRules, rules: saved } = settings.use(MENU_KEYS);
    let rules: Rule[] = [];
    try { rules = parseRules(saved); } catch { }
    const paused = readPausedRules(pausedRules);
    const now = Date.now();
    const globallyPaused = armed && pausedUntil > now;

    return h(Menu.Menu, { navId: "vc-vaa-pause-menu", onClose, "aria-label": "Emergency exit" },
        h(Menu.MenuGroup, null,
            h(Menu.MenuCheckboxItem, {
                id: "vc-vaa-armed", label: "Emergency exit", checked: armed,
                action: () => setArmed(!settings.store.armed)
            }),
            !armed ? null : globallyPaused
                ? h(Menu.MenuItem, { id: "vc-vaa-resume-all", label: "Resume all rules", subtext: `Paused ${formatUntil(pausedUntil)}`, action: resumeAll })
                : h(Menu.MenuItem, { id: "vc-vaa-pause-all", label: "Pause all rules" }, ...pauseAllItems())),
        h(Menu.MenuSeparator, null),
        h(Menu.MenuGroup, { label: "Rules" },
            ...(rules.length ? rules.map(rule => {
                const key = ruleKey(rule);
                const until = rulePausedUntil(key, paused, now);
                return h(Menu.MenuItem, {
                    id: `vc-vaa-rule-${menuId(key)}`,
                    label: ruleLabel(rule),
                    subtext: until !== null ? `Paused ${formatUntil(until)}` : "Active"
                }, ...(until !== null
                    ? [h(Menu.MenuItem, { id: `vc-vaa-resume-${menuId(key)}`, label: "Resume now", action: () => resumeRule(key) })]
                    : pauseItems(key)));
            }) : [h(Menu.MenuItem, { id: "vc-vaa-no-rules", label: "No rules yet", subtext: "Add them in the plugin settings", disabled: true })])));
}

/** Context menu for the user area button: toggle, pause everything or pause single rules. */
export function openPauseMenu(event: MouseEvent) {
    ContextMenuApi.openContextMenu(event, () => React.createElement(PauseMenu, { onClose: ContextMenuApi.closeContextMenu }));
}

function SimpleMenu({ label, items }: { label: string; items: () => ReturnType<typeof pauseItems>; }) {
    return React.createElement(Menu.Menu, { navId: "vc-vaa-pause-options", onClose: ContextMenuApi.closeContextMenu, "aria-label": label }, ...items());
}

export function openPauseAllMenu(event: MouseEvent) {
    ContextMenuApi.openContextMenu(event, () => React.createElement(SimpleMenu, { label: "Pause all rules", items: pauseAllItems }));
}

export function openRulePauseMenu(event: MouseEvent, key: string) {
    ContextMenuApi.openContextMenu(event, () => React.createElement(SimpleMenu, { label: "Pause rule", items: () => pauseItems(key) }));
}
