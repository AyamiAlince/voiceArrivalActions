/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import "./styles.css";

import { Button } from "@components/Button";
import { classNameFactory } from "@utils/css";
import { ChannelStore, GuildChannelStore, GuildMemberStore, GuildStore, IconUtils, React, UserStore, UserUtils, useStateFromStores } from "@webpack/common";
import type { ChangeEvent, FocusEvent, KeyboardEvent, ReactNode } from "react";

import { GUILD_VOICE, isSnowflake, parseRules, Rule, settings } from ".";

const cl = classNameFactory("vc-vaa-");
const MAX_SHOWN = 50;
const EDITOR_KEYS: ("rules" | "armed")[] = ["rules", "armed"];

type Choice = { value: string; label: string; note?: string; icon?: string; fallback?: string; round?: boolean; };
type UserLike = { id: string; username: string; globalName?: string | null; };
type DraftRule = { key: number; rule: Rule; };

const ACTIONS: { value: Rule["action"]; emoji: string; title: string; text: string; }[] = [
    { value: "leave", emoji: "🚪", title: "Leave", text: "Only you leave the channel. Works everywhere." },
    { value: "disconnect", emoji: "🔌", title: "Disconnect everyone", text: "Everyone else is disconnected from voice, then you leave." },
    { value: "move", emoji: "🔀", title: "Move everyone", text: "Everyone else is moved to another channel and you follow them." }
];

let nextKey = 0;
const toDraft = (rules: Rule[]): DraftRule[] => rules.map(rule => ({ key: nextKey++, rule }));
const initials = (label: string) => label.split(/\s+/).map(word => word[0]).join("").slice(0, 2).toUpperCase();
const displayName = (user: UserLike) => user.globalName || user.username;

function userChoice(user: UserLike): Choice {
    return { value: user.id, label: displayName(user), note: `@${user.username}`, icon: IconUtils.getUserAvatarURL(user as never, false, 64), round: true };
}

function ChoiceIcon({ choice, size = 32 }: { choice: Choice; size?: number; }) {
    const h = React.createElement;
    const [failed, setFailed] = React.useState(false);
    const style = { width: size, height: size };
    if (choice.icon && !failed)
        return h("img", { className: cl("icon"), "data-round": choice.round, style, src: choice.icon, alt: "", onError: () => setFailed(true) });
    return h("span", { className: cl("icon"), "data-round": choice.round, style, "aria-hidden": true }, choice.fallback ?? initials(choice.label));
}

function ChoiceText({ choice }: { choice: Choice; }) {
    const h = React.createElement;
    return h("span", { className: cl("choice-text") },
        h("span", { className: cl("choice-label") }, choice.label),
        choice.note ? h("span", { className: cl("choice-note") }, choice.note) : null);
}

function Picker({ selected, placeholder, optionsKey, getOptions, onChange, extra }: {
    selected: Choice | null; placeholder: string; optionsKey: string;
    getOptions: () => Choice[]; onChange: (value: string) => void; extra?: (query: string) => Choice | null;
}) {
    const h = React.createElement;
    const [open, setOpen] = React.useState(false);
    const [query, setQuery] = React.useState("");
    const [active, setActive] = React.useState(0);
    // Options are only built while the list is open, so large member lists cost nothing when closed.
    const options = React.useMemo(() => open ? getOptions() : [], [open, optionsKey]);
    const search = query.trim().toLowerCase();
    const matches = options.filter(o => `${o.label} ${o.note ?? ""} ${o.value}`.toLowerCase().includes(search));
    const custom = extra?.(query.trim());
    if (custom && !matches.some(o => o.value === custom.value)) matches.unshift(custom);
    const shown = matches.slice(0, MAX_SHOWN);

    function choose(choice: Choice) { onChange(choice.value); setOpen(false); }
    function onKeyDown(event: KeyboardEvent) {
        if (event.key === "Escape" && open) { event.stopPropagation(); setOpen(false); }
        else if (!open) return;
        else if (event.key === "ArrowDown") { event.preventDefault(); setActive(Math.min(active + 1, shown.length - 1)); }
        else if (event.key === "ArrowUp") { event.preventDefault(); setActive(Math.max(active - 1, 0)); }
        else if (event.key === "Enter" && shown[active]) { event.preventDefault(); choose(shown[active]); }
    }

    return h("div", {
        className: cl("picker"), onKeyDown,
        onBlur: (event: FocusEvent<HTMLDivElement>) => { if (!event.currentTarget.contains(event.relatedTarget as Node)) setOpen(false); }
    },
    h("button", {
        type: "button", className: cl("control"), "aria-haspopup": "listbox", "aria-expanded": open,
        onClick: () => { setOpen(!open); setQuery(""); setActive(0); }
    },
    selected ? h(ChoiceIcon, { key: selected.icon, choice: selected }) : null,
    selected ? h(ChoiceText, { choice: selected }) : h("span", { className: cl("placeholder") }, placeholder),
    h("span", { className: cl("chevron"), "aria-hidden": true }, open ? "▴" : "▾")),
    open ? h("div", { className: cl("popover") },
        h("input", {
            autoFocus: true, className: cl("search"), value: query, placeholder: "Search…", "aria-label": placeholder,
            onChange: (event: ChangeEvent<HTMLInputElement>) => { setQuery(event.target.value); setActive(0); }
        }),
        h("div", { className: cl("options"), role: "listbox" },
            ...shown.map((o, i) => h("button", {
                key: o.value, type: "button", role: "option", className: cl("option"),
                "aria-selected": selected?.value === o.value, "data-active": i === active,
                onMouseEnter: () => setActive(i), onClick: () => choose(o)
            }, h(ChoiceIcon, { key: o.icon, choice: o }), h(ChoiceText, { choice: o }), selected?.value === o.value ? h("span", { className: cl("check") }, "✓") : null)),
            !shown.length ? h("div", { className: cl("hint") }, "Nothing found.") : null,
            matches.length > shown.length ? h("div", { className: cl("hint") }, `${matches.length - shown.length} more. Keep typing to narrow it down.`) : null
        )) : null);
}

function Step({ number, title, hint, children }: { number: number; title: string; hint?: ReactNode; children?: ReactNode; }) {
    const h = React.createElement;
    return h("div", { className: cl("step"), role: "group", "aria-label": title },
        h("div", { className: cl("step-title") }, h("span", { className: cl("step-number") }, number), title),
        children,
        hint ? h("div", { className: cl("hint") }, hint) : null);
}

function RuleCard({ rule, index, update, remove }: {
    rule: Rule; index: number; update: (next: Rule) => void; remove: () => void;
}) {
    const h = React.createElement;
    const [expanded, setExpanded] = React.useState(() => !rule.userId || !rule.guildId);
    const guilds = useStateFromStores([GuildStore], () => GuildStore.getGuilds());
    const user = useStateFromStores([UserStore], () => isSnowflake(rule.userId) ? UserStore.getUser(rule.userId) : undefined, [rule.userId]);
    const channel = useStateFromStores([ChannelStore], () => rule.channelId ? ChannelStore.getChannel(rule.channelId) : undefined, [rule.channelId]);

    // Users who are not cached yet (pasted IDs) are fetched so their name and avatar can be shown.
    React.useEffect(() => {
        if (isSnowflake(rule.userId) && !UserStore.getUser(rule.userId)) UserUtils.getUser(rule.userId).catch(() => null);
    }, [rule.userId]);

    const guild = rule.guildId && rule.guildId !== "*" ? guilds[rule.guildId] : undefined;
    const allServers: Choice = { value: "*", label: "All servers", note: "Including servers you join later", fallback: "🌐" };
    const guildChoice = (g: { id: string; name: string; icon?: string | null; }): Choice =>
        ({ value: g.id, label: g.name, icon: g.icon ? IconUtils.getGuildIconURL({ id: g.id, icon: g.icon, size: 64 }) : undefined });
    const serverChoice = rule.guildId === "*" ? allServers : guild ? guildChoice(guild) : rule.guildId ? { value: rule.guildId, label: "Unavailable server", note: rule.guildId } : null;
    const personChoice = user ? userChoice(user) : isSnowflake(rule.userId)
        ? { value: rule.userId, label: "Unknown user", note: rule.userId, icon: IconUtils.getDefaultAvatarURL(rule.userId), round: true }
        : null;
    const channelChoice = channel ? { value: channel.id, label: channel.name, fallback: "🔊" } : rule.channelId ? { value: rule.channelId, label: "Unavailable channel", note: rule.channelId, fallback: "🔊" } : null;
    const action = ACTIONS.find(a => a.value === rule.action) ?? ACTIONS[0];
    const incomplete = !personChoice || !serverChoice || (rule.action === "move" && !channelChoice);

    const summary = h("div", { className: cl("summary") },
        h("div", { className: cl("avatar-wrap") },
            personChoice ? h(ChoiceIcon, { key: personChoice.icon, choice: personChoice, size: 48 }) : h("span", { className: cl("icon"), "data-round": true, style: { width: 48, height: 48 }, "aria-hidden": true }, "?"),
            serverChoice ? h("span", { className: cl("badge") }, h(ChoiceIcon, { key: serverChoice.icon, choice: serverChoice, size: 20 })) : null),
        h("div", { className: cl("summary-text") },
            h("div", { className: cl("summary-title") }, personChoice ? personChoice.label : `Rule ${index + 1}`,
                personChoice?.note ? h("span", { className: cl("choice-note") }, personChoice.note) : null),
            h("div", { className: cl("summary-line") },
                personChoice ? "When they join your voice channel" : "Choose who you want to avoid",
                serverChoice ? ` in ${serverChoice.label}` : "",
                h("span", { className: cl("pill"), "data-action": rule.action }, `${action.emoji} ${action.title}`),
                rule.action === "move" && channelChoice ? h("span", { className: cl("pill") }, `🔊 ${channelChoice.label}`) : null,
                incomplete ? h("span", { className: cl("pill"), "data-warning": true }, "Incomplete") : null)),
        h(Button, { variant: "secondary", size: "small", onClick: () => setExpanded(!expanded), "aria-expanded": expanded }, expanded ? "Done" : "Edit"),
        h(Button, { variant: "dangerSecondary", size: "small", onClick: remove, "aria-label": `Remove rule ${index + 1}` }, "Remove"));

    if (!expanded) return h("div", { className: cl("card") }, summary);

    return h("div", { className: cl("card") }, summary,
        h("div", { className: cl("body") },
            h(Step, { number: 1, title: "Who are you avoiding?", hint: "Search loaded members by name or paste a user ID." },
                h(Picker, {
                    selected: personChoice, placeholder: "Choose a person", optionsKey: rule.guildId,
                    getOptions: () => {
                        const me = UserStore.getCurrentUser()?.id;
                        const guildIds = rule.guildId && rule.guildId !== "*" ? [rule.guildId] : Object.keys(GuildStore.getGuilds());
                        const ids = new Set(guildIds.flatMap(id => GuildMemberStore.getMemberIds(id)));
                        return [...ids].flatMap(id => {
                            const member = id === me ? undefined : UserStore.getUser(id);
                            return member && !member.bot ? [userChoice(member)] : [];
                        }).sort((a, b) => a.label.toLowerCase() < b.label.toLowerCase() ? -1 : 1);
                    },
                    extra: query => isSnowflake(query)
                        ? UserStore.getUser(query) ? userChoice(UserStore.getUser(query)) : { value: query, label: "Use this user ID", note: query, fallback: "#" }
                        : null,
                    onChange: value => update({ ...rule, userId: value })
                })),
            h(Step, { number: 2, title: "Where should this rule work?", hint: rule.guildId === "*" ? "A rule for a specific server takes priority over this one." : undefined },
                h(Picker, {
                    selected: serverChoice, placeholder: "Choose a server", optionsKey: "guilds",
                    getOptions: () => [allServers, ...Object.values(GuildStore.getGuilds()).sort((a, b) => a.name.localeCompare(b.name)).map(guildChoice)],
                    onChange: value => update({ ...rule, guildId: value, channelId: undefined, action: value === "*" && rule.action === "move" ? "leave" : rule.action })
                })),
            h(Step, { number: 3, title: "What should happen?", hint: rule.action === "leave" ? undefined : "Needs the Move Members permission. The person you are avoiding stays where they are." },
                h("div", { className: cl("actions"), role: "radiogroup", "aria-label": "Action" },
                    ...ACTIONS.map(a => {
                        const disabled = a.value === "move" && rule.guildId === "*";
                        return h("button", {
                            key: a.value, type: "button", role: "radio", className: cl("action"), disabled,
                            "aria-checked": rule.action === a.value,
                            onClick: () => update({ ...rule, action: a.value, channelId: a.value === "move" ? rule.channelId : undefined })
                        },
                        h("span", { className: cl("action-emoji"), "aria-hidden": true }, a.emoji),
                        h("span", { className: cl("action-title") }, a.title),
                        h("span", { className: cl("action-text") }, disabled ? "Pick a specific server to move members." : a.text));
                    }))),
            rule.action === "move" ? h(Step, { number: 4, title: "Where should everyone go?" },
                h(Picker, {
                    selected: channelChoice, placeholder: "Choose a voice channel", optionsKey: rule.guildId,
                    getOptions: () => (GuildChannelStore.getChannels(rule.guildId)?.VOCAL ?? [])
                        .map(entry => entry.channel)
                        .filter(c => c.type === GUILD_VOICE)
                        .map(c => ({ value: c.id, label: c.name, fallback: "🔊" })),
                    onChange: value => update({ ...rule, channelId: value })
                })) : null));
}

export function RulesEditor() {
    // Discord's React export is only available after webpack initialization.
    const h = React.createElement;
    const { rules: saved, armed } = settings.use(EDITOR_KEYS);
    const [draft, setDraft] = React.useState<DraftRule[]>(() => {
        try { return toDraft(parseRules(saved)); } catch { return []; }
    });
    const [error, setError] = React.useState(() => {
        try { parseRules(saved); return ""; } catch { return "Saved rules could not be loaded. Recreate your rules and save to replace them."; }
    });
    const [status, setStatus] = React.useState("");
    const rules = draft.map(d => d.rule);
    const dirty = JSON.stringify(rules) !== saved;
    function change(next: DraftRule[]) { setDraft(next); setError(""); setStatus(""); }
    function save() {
        try {
            const validated = parseRules(JSON.stringify(rules));
            for (const rule of validated) {
                if (rule.guildId !== "*" && !GuildStore.getGuild(rule.guildId)) throw new Error("Choose a server you have joined.");
                if (rule.userId === UserStore.getCurrentUser()?.id) throw new Error("The person you avoid must be someone other than yourself.");
                if (rule.action === "move") {
                    const channel = rule.channelId ? ChannelStore.getChannel(rule.channelId) : null;
                    if (!channel || channel.guild_id !== rule.guildId || channel.type !== GUILD_VOICE)
                        throw new Error("Choose an available voice channel on the selected server.");
                }
            }
            settings.store.rules = JSON.stringify(validated);
            setError(""); setStatus("Rules saved.");
        } catch (err) { setError(err instanceof Error ? err.message : String(err)); setStatus(""); }
    }
    const addRule = () => change([...draft, { key: nextKey++, rule: { guildId: "", userId: "", action: "leave" } }]);

    return h("section", { className: cl("editor"), "aria-label": "Server rules" },
        h("div", { className: cl("armed"), "data-on": armed },
            h("span", { className: cl("dot"), "aria-hidden": true }),
            h("div", { className: cl("armed-text") },
                h("div", { className: cl("armed-title") }, armed ? "Emergency exit is on" : "Emergency exit is off"),
                h("div", { className: cl("hint") }, armed
                    ? "Saved rules run automatically when the person joins your voice channel."
                    : "Rules do nothing until this is on. You can also toggle it with the exit button next to your microphone.")),
            h(Button, { variant: armed ? "dangerSecondary" : "primary", size: "small", onClick: () => { settings.store.armed = !armed; } }, armed ? "Turn off" : "Turn on")),
        !draft.length
            ? h("div", { className: cl("empty") },
                h("div", { className: cl("empty-emoji"), "aria-hidden": true }, "🏃"),
                h("div", { className: cl("armed-title") }, "No one to avoid yet"),
                h("div", { className: cl("hint") }, "Add a rule, pick a person and choose what happens when they join your voice channel."))
            : h("div", { className: cl("list") }, ...draft.map((item, index) => h(RuleCard, {
                key: item.key, rule: item.rule, index,
                update: next => change(draft.map(d => d.key === item.key ? { key: d.key, rule: next } : d)),
                remove: () => change(draft.filter(d => d.key !== item.key))
            }))),
        error ? h("div", { className: cl("error"), role: "alert" }, error) : null,
        h("div", { className: cl("footer") },
            h(Button, { variant: "secondary", onClick: addRule }, "Add rule"),
            h(Button, { disabled: !dirty, onClick: save }, "Save rules"),
            h(Button, {
                variant: "secondary", disabled: !dirty, onClick: () => {
                    try { change(toDraft(parseRules(saved))); } catch { setError("Saved rules could not be loaded."); }
                }
            }, "Discard changes"),
            h("span", { className: cl("hint"), role: "status" }, status || (dirty ? "Unsaved changes. Save before closing settings." : "All changes saved.")))
    );
}
