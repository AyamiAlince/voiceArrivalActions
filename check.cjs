// Run with Node 22.6+: node voiceArrivalActions/check.cjs
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const { stripTypeScriptTypes } = require("node:module");
const source = fs.readFileSync(`${__dirname}/index.ts`, "utf8")
    .replace(/^import .*;\r?\n/gm, "")
    .replace(/^export (?=(?:const|function|type)\b)/gm, "")
    .replace("export default definePlugin(", "globalThis.plugin = definePlugin(");
let selected = "source";
let ids = ["me"];
let admin = true;
let reject = false;
const patches = [];
const selections = [];
const rules = [{ guildId: "111111111111111111", userId: "222222222222222222", action: "disconnect" }];
const listeners = new Set();
const context = vm.createContext({
    setTimeout, clearTimeout,
    definePlugin: p => p,
    definePluginSettings: definitions => {
        const values = { rules: JSON.stringify(rules), armed: false };
        return { store: new Proxy(values, {
            set(target, key, value) {
                target[key] = value;
                definitions[key]?.onChange?.(value);
                return true;
            }
        }), use: () => values };
    },
    React: { createElement: (type, props) => ({ type, props }) }, UserAreaButton: "button", RulesEditor() {},
    OptionType: { STRING: 1 }, Logger: class { error() {} },
    VoiceStateStore: {
        getVoiceStatesForChannel: () => Object.fromEntries(ids.map(userId => [userId, { userId }])),
        addChangeListener: f => listeners.add(f), removeChangeListener: f => listeners.delete(f)
    },
    SelectedChannelStore: { getVoiceChannelId: () => selected, addChangeListener() {}, removeChangeListener() {} },
    UserStore: { getCurrentUser: () => ({ id: "me" }) },
    ChannelStore: { getChannel: id => ({ id, guild_id: rules[0].guildId, type: 2 }) },
    ChannelActions: { selectVoiceChannel: id => { selections.push(id); selected = id; } },
    PermissionStore: { can: () => admin },
    PermissionsBits: { ADMINISTRATOR: 8n, VIEW_CHANNEL: 1024n, CONNECT: 1048576n },
    RestAPI: { patch: async request => { if (reject) throw Error("403"); patches.push(request); } },
    showToast() {}, Toasts: { Type: { FAILURE: "failure", MESSAGE: "message" } }
});
vm.runInContext(stripTypeScriptTypes(source), context);
const tick = () => new Promise(resolve => setTimeout(resolve, 10));
function change(next) { ids = next; listeners.forEach(f => f()); }
function reset(action, occupants = ["me", "other"]) {
    context.plugin.stop();
    selected = "source"; ids = occupants; admin = true; reject = false;
    patches.length = selections.length = 0;
    context.plugin.settings.store.rules = JSON.stringify([{ ...rules[0], action, channelId: "333333333333333333" }]);
    context.plugin.start();
    context.plugin.settings.store.armed = true;
}
(async () => {
    const target = rules[0].userId;
    reset("disconnect"); change(["me", "other", target]); await tick();
    assert.equal(patches.length, 1); assert.ok(patches[0].url.endsWith("/other"));
    assert.equal(patches[0].body.channel_id, null); assert.deepEqual(selections, [null]);
    reset("move"); change(["me", "other", target]); await tick();
    assert.equal(patches[0].body.channel_id, "333333333333333333");
    assert.deepEqual(selections, ["333333333333333333"]);
    reset("leave"); change(["me", "other", target]); await tick();
    assert.equal(patches.length, 0); assert.deepEqual(selections, [null]);
    reset("disconnect"); admin = false; change(["me", "other", target]); await tick();
    assert.equal(patches.length + selections.length, 0);
    reset("disconnect", ["me", target]); change(["me", target]); await tick();
    assert.equal(patches.length + selections.length, 0);
    reset("disconnect"); change(["me", "other", target]); context.plugin.stop(); await tick();
    assert.equal(patches.length + selections.length, 0);
    reset("disconnect"); reject = true; change(["me", "other", target]); await tick();
    assert.equal(patches.length + selections.length, 0);
    context.plugin.stop();
    reset("disconnect"); context.plugin.settings.store.armed = false;
    change(["me", "other", target]); await tick();
    assert.equal(patches.length + selections.length, 0);
    const button = context.plugin.userAreaButton.render({});
    assert.equal(button.props["aria-checked"], false);
    button.props.onClick();
    assert.equal(context.plugin.settings.store.armed, true);
    change(["me", "other", target]); await tick();
    assert.equal(patches.length + selections.length, 0);
    change(["me", "other"]); change(["me", "other", target]); await tick();
    assert.equal(patches.length, 1);
    reset("disconnect"); change(["me", "other", target]);
    context.plugin.settings.store.armed = false; await tick();
    assert.equal(patches.length + selections.length, 0);
    context.plugin.stop();
    console.log("10 voice action scenarios passed, including the toggle button and cancellation.");
    reset("leave");
    context.plugin.settings.store.rules = JSON.stringify([{ ...rules[0], guildId: "*", action: "disconnect" }]);
    change(["me", "other", target]); await tick();
    assert.equal(patches.length, 1);
    assert.ok(patches[0].url.includes(`/guilds/${rules[0].guildId}/`), "Global actions use the actual source server");
    reset("leave");
    context.plugin.settings.store.rules = JSON.stringify([
        { ...rules[0], guildId: "*", action: "disconnect" },
        { ...rules[0], action: "leave" }
    ]);
    change(["me", "other", target]); await tick();
    assert.equal(patches.length, 0, "Server rule overrides global action");
    assert.deepEqual(selections, [null]);
    assert.throws(() => context.parseRules(JSON.stringify([{ ...rules[0], guildId: "*", action: "move", channelId: "333333333333333333" }])));
    reset("leave");
    context.plugin.stop();
    console.log("Global rule checks passed: matching, actual server routing, overrides and destination validation.");
    checkEditor();
})().catch(error => { console.error(error); process.exitCode = 1; });

function checkEditor() {
    const hooks = [];
    let cursor = 0;
    context.React.createElement = (type, props, ...children) => ({ type, props: props ?? {}, children });
    context.React.useState = initial => {
        const index = cursor++;
        if (!(index in hooks)) hooks[index] = typeof initial === "function" ? initial() : initial;
        return [hooks[index], value => { hooks[index] = value; }];
    };
    context.Button = "button";
    context.GuildStore = { getGuild: id => id === rules[0].guildId ? { id } : null };
    const editorSource = fs.readFileSync(`${__dirname}/rulesEditor.ts`, "utf8")
        .replace(/^import .*;\r?\n/gm, "")
        .replace("export function RulesEditor", "function RulesEditor");
    const readyReact = context.React;
    context.React = undefined;
    assert.doesNotThrow(() => vm.runInContext(stripTypeScriptTypes(editorSource), context),
        "Editor import must not access React before Discord initializes it");
    context.React = readyReact;
    const saved = context.plugin.settings.store.rules;
    const render = () => { cursor = 0; return context.RulesEditor(); };
    function flatten(node) {
        if (!node || typeof node !== "object") return [];
        return [node, ...(node.children ?? []).flatMap(flatten)];
    }
    const button = (tree, label) => flatten(tree).find(n => n.type === "button" && n.children.includes(label));
    const cards = tree => flatten(tree).filter(n => typeof n.type === "function" && n.type.name === "RuleCard");
    let tree = render();
    assert.equal(cards(tree).length, 1, "Existing rules load into the editor");
    button(tree, "Add rule").props.onClick();
    tree = render();
    assert.equal(cards(tree).length, 2);
    button(tree, "Save rules").props.onClick();
    assert.equal(context.plugin.settings.store.rules, saved, "Incomplete rules must not overwrite saved rules");
    assert.ok(flatten(render()).some(n => n.props.role === "alert"));
    button(render(), "Discard changes").props.onClick();
    assert.equal(cards(render()).length, 1);
    cards(render())[0].props.update({ ...rules[0], action: "leave" });
    button(render(), "Save rules").props.onClick();
    assert.equal(JSON.parse(context.plugin.settings.store.rules)[0].action, "leave");
    cards(render())[0].props.remove();
    button(render(), "Save rules").props.onClick();
    assert.equal(context.plugin.settings.store.rules, "[]");
    console.log("Editor checks passed: migration, add, validation, discard, edit/save and remove/save.");
}
