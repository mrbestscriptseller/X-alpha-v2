(() => {
  const { metro, patcher, ui, plugin } = vendetta;
  const { FormSection, FormRow, FormSwitchRow, FormDivider, FormText } = ui.components.Forms;

  const VIEW_CHANNEL = 1n << 10n;
  const MANAGE_CHANNELS = 1n << 4n;
  const CATEGORY = 4;

  const cache = new Map();
  const inflight = new Set();
  const s = plugin.storage;
  s.enabled ??= true;
  s.showTopic ??= true;
  s.showSlowmode ??= true;

  const TYPES = ["text", "dm", "voice", "group", "category", "announcement", "store", "stage", "forum", "media"];

  const permMod = () => metro.findByProps("getChannelPermissions") ?? metro.findByProps("computePermissions");

  function permsFor(id) {
    try {
      const m = permMod();
      const fn = m?.getChannelPermissions ?? m?.computePermissions;
      const v = fn?.call(m, id);
      return typeof v === "bigint" ? v : 0n;
    } catch { return 0n; }
  }

  function canView(id) { return (permsFor(id) & VIEW_CHANNEL) === VIEW_CHANNEL; }

  function hasManage(guildId) {
    try {
      const m = permMod();
      const v = m?.getGuildPermissions?.call(m, guildId);
      return typeof v === "bigint" && (v & MANAGE_CHANNELS) === MANAGE_CHANNELS;
    } catch { return false; }
  }

  function token() {
    try {
      const a = metro.findByStoreName("AuthenticationStore");
      if (a?.getToken) return a.getToken();
      const b = metro.findByProps("getToken");
      if (typeof b?.getToken === "function") return b.getToken();
    } catch {}
    return null;
  }

  async function load(guildId) {
    if (!s.enabled || !guildId || cache.has(guildId) || inflight.has(guildId)) return;
    if (hasManage(guildId)) { cache.set(guildId, []); return; }
    const t = token();
    if (!t) return;
    inflight.add(guildId);
    try {
      const res = await fetch(`https://discord.com/api/v9/guilds/${guildId}/channels`, {
        headers: { Authorization: t, "Content-Type": "application/json" },
      });
      if (!res.ok) { cache.set(guildId, []); return; }
      const all = await res.json();
      const hidden = all
        .filter((c) => c.type !== CATEGORY && !canView(c.id))
        .map((c) => ({ ...c, __hidden: true }));
      cache.set(guildId, hidden);
      if (hidden.length) ui.toasts.showToast(`Hidden Channels: ${hidden.length} found`);
    } catch (e) {
      console.error("[HiddenChannels]", e);
    } finally {
      inflight.delete(guildId);
    }
  }

  function showInfo(ch) {
    const lines = [`Type: ${TYPES[ch.type] ?? ch.type}`];
    if (s.showTopic && ch.topic) lines.push(`Topic: ${ch.topic}`);
    if (s.showSlowmode && ch.slowmode) lines.push(`Slowmode: ${ch.slowmode}s`);
    if (ch.nsfw) lines.push("NSFW: yes");
    if (ch.bitrate) lines.push(`Bitrate: ${Math.round(ch.bitrate / 1000)}kbps`);
    if (ch.user_limit) lines.push(`User limit: ${ch.user_limit}`);
    lines.push("", "You don't have access to this channel.");
    metro.common.ReactNative.Alert.alert(ch.name, lines.join("\n"), [{ text: "Close" }]);
  }

  const ChannelStore = metro.findByStoreName("ChannelStore");
  const GuildStore = metro.findByStoreName("GuildStore");
  const nav = metro.findByProps("selectChannel");
  const unpatch = [];

  if (ChannelStore) {
    unpatch.push(
      patcher.after("getSortedChannels", ChannelStore, ([guildId], res) => {
        const hidden = cache.get(guildId);
        if (!hidden?.length) return;
        if (!res) res = {};
        for (const ch of hidden) {
          const key = ch.parent_id ?? "null";
          if (!Array.isArray(res[key])) res[key] = [];
          if (!res[key].some((c) => c.id === ch.id)) res[key].push(ch);
        }
        return res;
      })
    );

    unpatch.push(
      patcher.after("getChannel", ChannelStore, ([id], res) => {
        if (res) return;
        for (const list of cache.values()) {
          const hit = list.find((c) => c.id === id);
          if (hit) return hit;
        }
      })
    );

    unpatch.push(
      patcher.after("hasChannel", ChannelStore, ([id], res) => {
        if (res) return;
        for (const list of cache.values()) if (list.some((c) => c.id === id)) return true;
      })
    );
  }

  if (nav?.selectChannel) {
    unpatch.push(
      patcher.instead("selectChannel", nav, (args, orig) => {
        const [guildId, channelId] = args;
        const hit = cache.get(guildId)?.find((c) => c.id === channelId);
        if (hit) { showInfo(hit); return Promise.resolve(); }
        return orig.apply(nav, args);
      })
    );
  }

  if (GuildStore) {
    unpatch.push(
      patcher.after("getGuild", GuildStore, ([id]) => { load(id); })
    );
  }

  function Settings() {
    const [, force] = metro.common.React.useReducer((n) => n + 1, 0);
    const row = (key, label, sub) =>
      metro.common.React.createElement(FormSwitchRow, {
        label, subLabel: sub, value: s[key],
        onValueChange: (v) => { s[key] = v; force(); },
      });

    return metro.common.React.createElement(
      metro.common.ReactNative.ScrollView,
      { style: { flex: 1 } },
      metro.common.React.createElement(FormSection, { title: "Behaviour" },
        row("enabled", "Enabled", "Show locked channels in the sidebar"),
        row("showTopic", "Show topics", "Include channel topics"),
        row("showSlowmode", "Show slowmode", "Include slowmode values")
      ),
      metro.common.React.createElement(FormSection, { title: "Cache" },
        metro.common.React.createElement(FormRow, {
          label: "Clear cache",
          subLabel: `${[...cache.values()].flat().length} channels cached`,
          onPress: () => { cache.clear(); force(); ui.toasts.showToast("Cache cleared"); },
        })
      ),
      metro.common.React.createElement(FormSection, null,
        metro.common.React.createElement(FormText, null,
          "Channels you can't view are appended to their category. Tap one for its metadata. Messages and pins aren't available — Discord won't serve them without permission.")
      ),
      metro.common.React.createElement(FormDivider, null)
    );
  }

  return {
    onLoad() { load(metro.findByStoreName("GuildStore")?.getGuildId?.()); },
    onUnload() { unpatch.forEach((u) => { try { u(); } catch {} }); cache.clear(); },
    settings: Settings,
  };
})()