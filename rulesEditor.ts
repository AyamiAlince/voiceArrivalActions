import { Button } from "@components/Button";
import { ChannelStore, GuildChannelStore, GuildMemberStore, GuildStore, React, UserStore, useStateFromStores } from "@webpack/common";
import type { ChangeEvent, CSSProperties, FocusEvent, KeyboardEvent, ReactNode, SyntheticEvent } from "react";

import { parseRules, Rule, settings } from ".";

const controlStyle: CSSProperties = {
    width: "100%", boxSizing: "border-box", padding: "8px", borderRadius: "4px",
    background: "var(--input-background, var(--background-secondary))",
    color: "var(--text-normal)", border: "1px solid var(--background-modifier-accent)"
};
const stack: CSSProperties = { display: "flex", flexDirection: "column", gap: "12px" };

type Choice = { value: string; label: string; icon?: string; };

function Picker({ value, options, placeholder, onChange }: {
    value: string; options: Choice[]; placeholder: string; onChange: (value: string) => void;
}) {
    const h = React.createElement;
    const [open, setOpen] = React.useState(false);
    const [query, setQuery] = React.useState("");
    const selected = options.find(option => option.value === value);
    const icon = (option: Choice) => option.icon
        ? h("img", { src: option.icon, alt: "", width: 32, height: 32, style: { borderRadius: "10px", flexShrink: 0 }, onError: (event: SyntheticEvent<HTMLImageElement>) => { event.currentTarget.style.display = "none"; } })
        : h("span", { "aria-hidden": true, style: { width: "32px", height: "32px", borderRadius: "10px", display: "grid", placeItems: "center", background: "var(--background-modifier-accent)", flexShrink: 0 } }, option.value === "*" ? "◎" : option.label.slice(0, 2).toUpperCase());
    const rowStyle: CSSProperties = { ...controlStyle, display: "flex", alignItems: "center", gap: "10px", textAlign: "left", cursor: "pointer" };
    return h("div", { style: stack, onKeyDown: (event: KeyboardEvent) => { if (event.key === "Escape") setOpen(false); },
        onBlur: (event: FocusEvent<HTMLDivElement>) => { if (!event.currentTarget.contains(event.relatedTarget as Node)) setOpen(false); } },
        h("button", { type: "button", style: rowStyle, "aria-label": placeholder, "aria-expanded": open,
            onClick: () => { setOpen(!open); setQuery(""); } },
        selected ? icon(selected) : null, h("span", { style: { flex: 1 } }, selected?.label || (value ? `Unavailable (${value})` : placeholder)), "▾"),
        open ? h("div", { style: { ...stack, gap: "6px", padding: "8px", borderRadius: "8px", background: "var(--background-secondary)", border: "1px solid var(--background-modifier-accent)" } },
            h("input", { autoFocus: true, style: controlStyle, value: query, placeholder: "Search…", "aria-label": `Search ${placeholder.toLowerCase()}`,
                onChange: (event: ChangeEvent<HTMLInputElement>) => setQuery(event.target.value) }),
            h("div", { style: { ...stack, gap: "4px", maxHeight: "240px", overflowY: "auto" } },
                ...options.filter(o => `${o.label} ${o.value}`.toLowerCase().includes(query.toLowerCase())).map(o => h("button", {
                    key: o.value, type: "button", style: { ...rowStyle, background: value === o.value ? "var(--background-modifier-selected)" : "var(--background-secondary)" },
                    "aria-pressed": value === o.value, onClick: () => { onChange(o.value); setOpen(false); }
                }, icon(o), h("span", { style: { flex: 1 } }, o.label), value === o.value ? "✓" : null)),
                !options.some(o => `${o.label} ${o.value}`.toLowerCase().includes(query.toLowerCase())) ? h("small", null, "No matches.") : null)) : null);
}

function field(title: string, child: ReactNode) {
    const h = React.createElement;
    return h("div", { role: "group", "aria-label": title, style: { ...stack, gap: "4px" } }, h("span", null, title), child);
}

function RuleCard({ rule, index, update, remove }: {
    rule: Rule; index: number; update: (next: Rule) => void; remove: () => void;
}) {
    const h = React.createElement;
    const listId = React.useId();
    const guilds = useStateFromStores([GuildStore], () => Object.values(GuildStore.getGuilds())
        .sort((a, b) => a.name.localeCompare(b.name)));
    const channels = useStateFromStores([GuildChannelStore, ChannelStore], () => rule.guildId && rule.guildId !== "*"
        ? (GuildChannelStore.getChannels(rule.guildId)?.VOCAL ?? []).map(entry => entry.channel).filter(c => c.type === 2)
        : [], [rule.guildId]);
    const users = useStateFromStores([GuildMemberStore, UserStore, GuildStore], () => rule.guildId
        ? [...new Set((rule.guildId === "*" ? Object.keys(GuildStore.getGuilds()) : [rule.guildId]).flatMap(id => GuildMemberStore.getMemberIds(id)))].map(id => ({ id, user: UserStore.getUser(id) }))
        : [], [rule.guildId]);
    const knownUser = UserStore.getUser(rule.userId);
    return h("fieldset", { style: { ...stack, margin: 0, padding: "16px", borderRadius: "8px", border: "1px solid var(--background-modifier-accent)", minWidth: 0 } },
        h("legend", null, `Rule ${index + 1}`),
        field("Server", h(Picker, {
            value: rule.guildId, placeholder: "Choose a server",
            options: [{ value: "*", label: "All servers" }, ...guilds.map(g => ({ value: g.id, label: g.name,
                icon: g.icon ? `https://cdn.discordapp.com/icons/${g.id}/${g.icon}.png?size=64` : undefined }))],
            onChange: value => update({ ...rule, guildId: value, channelId: undefined, action: value === "*" && rule.action === "move" ? "leave" : rule.action })
        })),
        rule.guildId === "*" ? h("small", null, "Applies to every server, including servers you join later. A rule for a specific server takes priority. To move members, add a server-specific rule with its destination.") : null,
        field("Watched user", h("input", {
            style: controlStyle, value: rule.userId, list: listId, placeholder: "Search a loaded member or paste a user ID",
            onChange: (event: ChangeEvent<HTMLInputElement>) => update({ ...rule, userId: event.target.value.trim() })
        })),
        h("datalist", { id: listId }, ...users.map(({ id, user }) => h("option", { key: id, value: id }, user?.globalName || user?.username || id))),
        h("small", null, knownUser ? `Selected: ${knownUser.globalName || knownUser.username}` : "Only loaded members appear in suggestions. You can always paste a user ID."),
        field("Action", h(Picker, {
            value: rule.action, placeholder: "Choose an action",
            options: [{ value: "leave", label: "Leave by myself" }, { value: "disconnect", label: "Disconnect everyone else and leave" },
                ...(rule.guildId === "*" ? [] : [{ value: "move", label: "Move everyone else and myself" }])],
            onChange: value => update({ ...rule, action: value as Rule["action"] })
        })),
        rule.action === "move" ? field("Destination voice channel", h(Picker, {
            value: rule.channelId ?? "", placeholder: "Choose a voice channel",
            options: channels.map(c => ({ value: c.id, label: c.name })),
            onChange: value => update({ ...rule, channelId: value })
        })) : null,
        h("small", null, rule.action === "leave" ? "Only you leave the channel." : "Requires Administrator permission. The watched user stays in the original channel."),
        h(Button, { variant: "secondary", onClick: remove }, "Remove rule")
    );
}

export function RulesEditor() {
    // Discord's React export is only available after webpack initialization.
    const h = React.createElement;
    const { rules: saved } = settings.use(["rules"]);
    const [draft, setDraft] = React.useState<Rule[]>(() => {
        try { return parseRules(saved); } catch { return []; }
    });
    const [error, setError] = React.useState(() => {
        try { parseRules(saved); return ""; } catch { return "Saved rules could not be loaded. Recreate your rules and save to replace them."; }
    });
    const [status, setStatus] = React.useState("");
    const dirty = JSON.stringify(draft) !== saved;
    function change(next: Rule[]) { setDraft(next); setError(""); setStatus(""); }
    function save() {
        try {
            const validated = parseRules(JSON.stringify(draft));
            for (const rule of validated) {
                if (rule.guildId !== "*" && !GuildStore.getGuild(rule.guildId)) throw new Error("Choose a server you have joined.");
                if (rule.userId === UserStore.getCurrentUser()?.id) throw new Error("The watched user must be someone other than yourself.");
                if (rule.action === "move") {
                    const channel = ChannelStore.getChannel(rule.channelId!);
                    if (!channel || channel.guild_id !== rule.guildId || channel.type !== 2)
                        throw new Error("Choose an available voice channel on the selected server.");
                }
            }
            settings.store.rules = JSON.stringify(validated);
            setError(""); setStatus("Rules saved.");
        } catch (err) { setError(err instanceof Error ? err.message : String(err)); setStatus(""); }
    }
    return h("section", { style: { ...stack, color: "var(--text-normal)" }, "aria-label": "Server rules" },
        h("h3", { style: { margin: 0 } }, "Server rules"),
        h("p", { style: { margin: 0 } }, "Choose what happens when a watched user joins your current voice channel. Enable Emergency exit above or with the arrow button next to your microphone."),
        !draft.length ? h("p", null, "No rules yet. Add your first rule below.") : null,
        ...draft.map((rule, index) => h(RuleCard, {
            key: index, rule, index,
            update: next => change(draft.map((item, i) => i === index ? next : item)),
            remove: () => change(draft.filter((_, i) => i !== index))
        })),
        error ? h("p", { role: "alert", style: { color: "var(--text-danger)" } }, error) : null,
        h("div", { style: { display: "flex", gap: "8px", flexWrap: "wrap" } },
            h(Button, { variant: "secondary", onClick: () => change([...draft, { guildId: "", userId: "", action: "leave" }]) }, "Add rule"),
            h(Button, { disabled: !dirty, onClick: save }, "Save rules"),
            h(Button, { variant: "secondary", disabled: !dirty, onClick: () => {
                try { change(parseRules(saved)); } catch { setError("Saved rules could not be loaded."); }
            } }, "Discard changes")
        ),
        h("small", { role: "status" }, status || (dirty ? "Unsaved changes. Save before closing settings." : "All changes saved."))
    );
}
