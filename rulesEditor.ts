import { Button } from "@components/Button";
import { ChannelStore, GuildChannelStore, GuildMemberStore, GuildStore, React, UserStore, useStateFromStores } from "@webpack/common";
import type { ChangeEvent, CSSProperties, ReactNode } from "react";

import { parseRules, Rule, settings } from ".";

const controlStyle: CSSProperties = {
    width: "100%", boxSizing: "border-box", padding: "8px", borderRadius: "4px",
    background: "var(--input-background, var(--background-secondary))",
    color: "var(--text-normal)", border: "1px solid var(--background-modifier-accent)"
};
const stack: CSSProperties = { display: "flex", flexDirection: "column", gap: "12px" };

function field(title: string, child: ReactNode) {
    const h = React.createElement;
    return h("label", { style: { ...stack, gap: "4px" } }, h("span", null, title), child);
}

function RuleCard({ rule, index, update, remove }: {
    rule: Rule; index: number; update: (next: Rule) => void; remove: () => void;
}) {
    const h = React.createElement;
    const listId = React.useId();
    const guilds = useStateFromStores([GuildStore], () => Object.values(GuildStore.getGuilds())
        .sort((a, b) => a.name.localeCompare(b.name)));
    const channels = useStateFromStores([GuildChannelStore, ChannelStore], () => rule.guildId
        ? (GuildChannelStore.getChannels(rule.guildId)?.VOCAL ?? []).map(entry => entry.channel).filter(c => c.type === 2)
        : [], [rule.guildId]);
    const users = useStateFromStores([GuildMemberStore, UserStore], () => rule.guildId
        ? GuildMemberStore.getMemberIds(rule.guildId).map(id => ({ id, user: UserStore.getUser(id) }))
        : [], [rule.guildId]);
    const knownUser = UserStore.getUser(rule.userId);
    return h("fieldset", { style: { ...stack, margin: 0, padding: "16px", borderRadius: "8px", border: "1px solid var(--background-modifier-accent)", minWidth: 0 } },
        h("legend", null, `Rule ${index + 1}`),
        field("Server", h("select", {
            style: controlStyle, value: rule.guildId,
            onChange: (event: ChangeEvent<HTMLSelectElement>) => update({ ...rule, guildId: event.target.value, channelId: undefined })
        }, h("option", { value: "" }, "Choose a server"),
        rule.guildId && !guilds.some(g => g.id === rule.guildId) ? h("option", { value: rule.guildId }, `Unavailable server (${rule.guildId})`) : null,
        ...guilds.map(g => h("option", { key: g.id, value: g.id }, g.name)))),
        field("Watched user", h("input", {
            style: controlStyle, value: rule.userId, list: listId, placeholder: "Search a loaded member or paste a user ID",
            onChange: (event: ChangeEvent<HTMLInputElement>) => update({ ...rule, userId: event.target.value.trim() })
        })),
        h("datalist", { id: listId }, ...users.map(({ id, user }) => h("option", { key: id, value: id }, user?.globalName || user?.username || id))),
        h("small", null, knownUser ? `Selected: ${knownUser.globalName || knownUser.username}` : "Only loaded members appear in suggestions. You can always paste a user ID."),
        field("Action", h("select", {
            style: controlStyle, value: rule.action,
            onChange: (event: ChangeEvent<HTMLSelectElement>) => update({ ...rule, action: event.target.value as Rule["action"] })
        }, h("option", { value: "leave" }, "Leave by myself"),
        h("option", { value: "disconnect" }, "Disconnect everyone else and leave"),
        h("option", { value: "move" }, "Move everyone else and myself"))),
        rule.action === "move" ? field("Destination voice channel", h("select", {
            style: controlStyle, value: rule.channelId ?? "", disabled: !rule.guildId,
            onChange: (event: ChangeEvent<HTMLSelectElement>) => update({ ...rule, channelId: event.target.value })
        }, h("option", { value: "" }, "Choose a voice channel"),
        rule.channelId && !channels.some(c => c.id === rule.channelId) ? h("option", { value: rule.channelId }, `Unavailable channel (${rule.channelId})`) : null,
        ...channels.map(c => h("option", { key: c.id, value: c.id }, c.name)))) : null,
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
                if (!GuildStore.getGuild(rule.guildId)) throw new Error("Choose a server you have joined.");
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
