window.__ModuleLoader__.load({
  id: 'dsh-openilink-channel',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    const NS = 'openilink';
    const ROUTES = {
      status: '/openilink/im-openilink/status',
      config: '/openilink/im-openilink/config',
      settings: '/openilink/im-openilink/settings',
      models: '/openilink/im-openilink/models',
    };

    const DICTS = {
      zh: {
        'section.title': 'OpeniLink 微信',
        'status.checking': '检查中…',
        'status.connected': '已连接',
        'status.connecting': '连接中',
        'status.disconnected': '未连接',
        'status.stopped': '已停止',
        'status.unconfigured': '未配置',
        'status.error': '连接异常',
        'status.bot': '机器人',
        'status.sessions': '活跃会话',
        'status.direct': '私聊',
        'status.group': '群',
        'status.lastError': '最近错误',
        'form.hubUrl': 'Hub 地址',
        'form.hubUrlHint': '例如 https://hub.openilink.com',
        'form.appToken': 'App Token',
        'form.appTokenHint': '在 Hub 的 Bot 详情 → 应用市场 → 安装 OpeniLink → 复制 Token',
        'form.save': '保存并连接',
        'form.saving': '正在保存…',
        'form.saved': '已保存，插件正在重新加载',
        'form.refresh': '刷新状态',
        'form.intro': '通过 OpeniLink Hub 把微信消息接到本机 DeepSeek Harness Agent。',
        'form.unconfiguredHint': '填写下方两项后保存，即可开始收发微信消息。',
        'model.title': '模型与回复内容',
        'model.current': '当前生效',
        'model.hostDefault': '宿主默认',
        'model.inherit': '继承宿主默认',
        'model.provider': 'Provider',
        'model.providerHint': '留空沿用宿主默认',
        'model.model': '模型',
        'model.modelHint': '留空沿用宿主默认',
        'model.effort': '推理强度',
        'model.effortHint': '留空使用模型默认',
        'model.showReasoning': '发送思考过程',
        'model.showReasoningHint': '把模型的思考内容作为消息发到微信',
        'model.showTools': '发送工具使用',
        'model.showToolsHint': '把工具调用与执行结果发到微信',
        'model.save': '保存设置',
        'model.saving': '正在保存…',
        'model.saved': '已保存，插件正在重新加载',
        'model.sameAsDefault': '与宿主默认一致',
        'model.override': '已覆盖宿主默认',
      },
      en: {
        'section.title': 'OpeniLink WeChat',
        'status.checking': 'Checking…',
        'status.connected': 'Connected',
        'status.connecting': 'Connecting',
        'status.disconnected': 'Disconnected',
        'status.stopped': 'Stopped',
        'status.unconfigured': 'Not configured',
        'status.error': 'Connection error',
        'status.bot': 'Bot',
        'status.sessions': 'Active sessions',
        'status.direct': 'Direct',
        'status.group': 'Group',
        'status.lastError': 'Last error',
        'form.hubUrl': 'Hub URL',
        'form.hubUrlHint': 'e.g. https://hub.openilink.com',
        'form.appToken': 'App Token',
        'form.appTokenHint': 'Bot details → App marketplace → install OpeniLink → copy the Token',
        'form.save': 'Save and connect',
        'form.saving': 'Saving…',
        'form.saved': 'Saved. The plugin is reloading.',
        'form.refresh': 'Refresh status',
        'form.intro': 'Bridge WeChat messages to this local DeepSeek Harness agent through OpeniLink Hub.',
        'form.unconfiguredHint': 'Fill in both fields below and save to start receiving WeChat messages.',
        'model.title': 'Model and reply content',
        'model.current': 'In effect',
        'model.hostDefault': 'host default',
        'model.inherit': 'Inherit host default',
        'model.provider': 'Provider',
        'model.providerHint': 'Empty inherits the host default',
        'model.model': 'Model',
        'model.modelHint': 'Empty inherits the host default',
        'model.effort': 'Reasoning effort',
        'model.effortHint': 'Empty uses the model default',
        'model.showReasoning': 'Send reasoning',
        'model.showReasoningHint': 'Post the model reasoning content to WeChat',
        'model.showTools': 'Send tool usage',
        'model.showToolsHint': 'Post tool calls and their results to WeChat',
        'model.save': 'Save settings',
        'model.saving': 'Saving…',
        'model.saved': 'Saved. The plugin is reloading.',
        'model.sameAsDefault': 'Same as host default',
        'model.override': 'Overrides host default',
      },
    };

    const CSS = `
.olx-root { display: flex; flex-direction: column; gap: 14px; max-width: 620px; font-size: 14px; }
.olx-title { margin: 0; font-size: 15px; font-weight: 600; }
.olx-intro { margin: 0; font-size: 13px; line-height: 1.6; color: var(--dsw-alias-label-tertiary); }
.olx-card { display: flex; flex-direction: column; gap: 10px; padding: 12px 14px; border-radius: 10px; border: 1px solid var(--dsw-alias-border-l2); }
.olx-card-title { margin: 0; font-size: 13px; font-weight: 600; }
.olx-row { display: flex; align-items: center; gap: 8px; font-size: 13px; }
.olx-dot { width: 8px; height: 8px; border-radius: 50%; flex: none; background: var(--dsw-alias-label-tertiary); }
.olx-dot[data-state="connected"] { background: var(--dsw-alias-state-business-primary); }
.olx-dot[data-state="error"] { background: var(--dsw-alias-danger); }
.olx-dot[data-state="disconnected"] { background: var(--dsw-alias-warning, #e0a800); }
.olx-label { color: var(--dsw-alias-label-tertiary); }
.olx-value { font-family: var(--ds-font-family-code); overflow-wrap: anywhere; }
.olx-list { margin: 0; padding-left: 18px; font-size: 13px; display: flex; flex-direction: column; gap: 2px; }
.olx-field { display: flex; flex-direction: column; gap: 5px; }
.olx-field-label { font-size: 13px; font-weight: 500; }
.olx-hint { margin: 0; font-size: 12px; color: var(--dsw-alias-label-tertiary); }
.olx-input { box-sizing: border-box; width: 100%; padding: 8px 10px; font: inherit; font-size: 13px; color: inherit; border-radius: 8px; border: 1px solid var(--dsw-alias-border-l2); background: var(--dsw-alias-bg-input, transparent); outline: none; }
.olx-input:focus { border-color: var(--dsw-alias-state-business-primary); }
.olx-actions { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.olx-btn { font: inherit; font-size: 13px; padding: 7px 16px; border-radius: 8px; cursor: pointer; color: inherit; border: 1px solid var(--dsw-alias-border-l2); background: transparent; transition: background-color .15s ease, opacity .15s ease; }
.olx-btn:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover, rgba(128,128,128,.12)); }
.olx-btn:disabled { opacity: .5; cursor: default; }
.olx-btn--primary { border-color: transparent; color: #fff; font-weight: 500; background: var(--dsw-alias-state-business-primary, #4d6bfe); }
.olx-note { margin: 0; font-size: 12px; }
.olx-note--ok { color: var(--dsw-alias-state-business-primary); }
.olx-note--error { color: var(--dsw-alias-danger); }
.olx-check { display: flex; align-items: flex-start; gap: 8px; font-size: 13px; cursor: pointer; }
.olx-check input { margin: 2px 0 0; }
.olx-check-text { display: flex; flex-direction: column; gap: 2px; }
.olx-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 10px; }
`;

    function useStyles() {
      React.useEffect(() => {
        if (typeof document === 'undefined') return undefined;
        const id = 'dsh-openilink-channel-styles';
        if (document.getElementById(id) !== null) return undefined;
        const style = document.createElement('style');
        style.id = id;
        style.textContent = CSS;
        document.head.appendChild(style);
        return () => style.remove();
      }, []);
    }

    /** 取当前 locale 上下文（{ locale, t }）；注意 `t` 是字段，不是返回值本身。 */
    function useTranslate() {
      return React.useContext(LocaleContext);
    }

    const LocaleContext = React.createContext({
      locale: 'zh',
      t: (key) => key,
    });

    function readLocale(ctx) {
      try {
        return ctx.locale?.getSnapshot?.()?.active ?? 'zh';
      } catch {
        return 'zh';
      }
    }

    /** 订阅 locale 变更：切换语言时整块重新渲染。 */
    function useLocaleRevision(ctx) {
      const [revision, setRevision] = React.useState(() => ctx.locale?.getSnapshot?.()?.revision ?? 0);
      React.useEffect(() => {
        if (typeof ctx.locale?.subscribe !== 'function') return undefined;
        return ctx.locale.subscribe(() => {
          setRevision(ctx.locale.getSnapshot()?.revision ?? 0);
        });
      }, [ctx]);
      return revision;
    }

    async function getJson(path, signal) {
      const res = await fetch(path, { cache: 'no-store', signal });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    }

    async function postJson(path, body) {
      const res = await fetch(path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      const payload = await res.json().catch(() => ({}));
      return { ok: res.ok && payload?.ok === true, status: res.status, payload };
    }

    function stateLabel(t, state) {
      switch (state) {
        case 'connected':
          return t('status.connected');
        case 'connecting':
          return t('status.connecting');
        case 'disconnected':
          return t('status.disconnected');
        case 'stopped':
          return t('status.stopped');
        case 'unconfigured':
          return t('status.unconfigured');
        case 'error':
          return t('status.error');
        default:
          return t('status.checking');
      }
    }

    const EMPTY_SETTINGS = {
      provider: '',
      model: '',
      reasoningEffort: '',
      showReasoning: true,
      showTools: true,
    };

    /** 归一化服务端返回的设置，缺字段时用默认值。 */
    function normalizeSettings(raw) {
      const value = raw !== null && typeof raw === 'object' ? raw : {};
      return {
        provider: typeof value.provider === 'string' ? value.provider : '',
        model: typeof value.model === 'string' ? value.model : '',
        reasoningEffort: typeof value.reasoningEffort === 'string' ? value.reasoningEffort : '',
        showReasoning: value.showReasoning !== false,
        showTools: value.showTools !== false,
      };
    }

    function sameSettings(a, b) {
      return (
        a.provider === b.provider &&
        a.model === b.model &&
        a.reasoningEffort === b.reasoningEffort &&
        a.showReasoning === b.showReasoning &&
        a.showTools === b.showTools
      );
    }

    function uniqueSorted(values) {
      return [...new Set(values.filter((value) => value !== ''))].sort();
    }

    function Panel() {
      useStyles();
      const { t } = useTranslate();
      const [status, setStatus] = React.useState(undefined);
      const [loadError, setLoadError] = React.useState('');
      const [hubUrl, setHubUrl] = React.useState('');
      const [appToken, setAppToken] = React.useState('');
      const [busy, setBusy] = React.useState(false);
      const [note, setNote] = React.useState(undefined);
      const [tick, setTick] = React.useState(0);

      const [initial, setInitial] = React.useState(EMPTY_SETTINGS);
      const [draft, setDraft] = React.useState(EMPTY_SETTINGS);
      const [hostDefault, setHostDefault] = React.useState(undefined);
      const [catalog, setCatalog] = React.useState({ providers: [], models: [] });
      const [busySettings, setBusySettings] = React.useState(false);
      const [settingsNote, setSettingsNote] = React.useState(undefined);

      React.useEffect(() => {
        const controller = new AbortController();
        let alive = true;
        getJson(ROUTES.status, controller.signal)
          .then((value) => {
            if (!alive) return;
            setStatus(value);
            setLoadError('');
            if (value?.hubUrl) setHubUrl((current) => current || value.hubUrl);
          })
          .catch((error) => {
            if (!alive) return;
            if (error?.name === 'AbortError') return;
            setLoadError(String(error?.message ?? error));
          });
        return () => {
          alive = false;
          controller.abort();
        };
      }, [tick]);

      React.useEffect(() => {
        const controller = new AbortController();
        let alive = true;
        getJson(ROUTES.settings, controller.signal)
          .then((value) => {
            if (!alive) return;
            const next = normalizeSettings(value?.settings);
            setInitial(next);
            setDraft(next);
            setHostDefault(value?.hostDefault);
          })
          .catch(() => {
            // 设置读取失败不阻塞连接配置：保留默认值。
          });
        return () => {
          alive = false;
          controller.abort();
        };
      }, [tick]);

      React.useEffect(() => {
        const controller = new AbortController();
        let alive = true;
        getJson(ROUTES.models, controller.signal)
          .then((value) => {
            if (!alive) return;
            setCatalog({
              providers: Array.isArray(value?.providers) ? value.providers : [],
              models: Array.isArray(value?.models) ? value.models : [],
            });
          })
          .catch(() => {
            // 模型目录不可用时仍可手动输入。
          });
        return () => {
          alive = false;
          controller.abort();
        };
      }, [tick]);

      const dirty = hubUrl.trim() !== '' && appToken.trim() !== '';
      const state = status?.state ?? 'checking';

      const onSubmit = async (event) => {
        event.preventDefault();
        if (busy) return;
        setBusy(true);
        setNote(undefined);
        try {
          const { ok, status: code, payload } = await postJson(ROUTES.config, {
            hubUrl: hubUrl.trim(),
            appToken: appToken.trim(),
          });
          if (ok) {
            // 缺 bot:read 这类非致命提示：保存成功，但要说清为什么读不到 Bot 名称。
            setNote({
              ok: true,
              text: payload?.warning ? `${t('form.saved')}（${payload.warning}）` : t('form.saved'),
            });
            setAppToken('');
            setTick((value) => value + 1);
          } else {
            setNote({ ok: false, text: String(payload?.error ?? `HTTP ${code}`) });
          }
        } catch (error) {
          setNote({ ok: false, text: String(error?.message ?? error) });
        } finally {
          setBusy(false);
        }
      };

      const settingsDirty = !sameSettings(draft, initial);

      const onSaveSettings = async (event) => {
        event.preventDefault();
        if (busySettings || !settingsDirty) return;
        setBusySettings(true);
        setSettingsNote(undefined);
        try {
          const { ok, status: code, payload } = await postJson(ROUTES.settings, draft);
          if (ok) {
            setSettingsNote({ ok: true, text: t('model.saved') });
            setInitial(draft);
            setTick((value) => value + 1);
          } else {
            setSettingsNote({ ok: false, text: String(payload?.error ?? `HTTP ${code}`) });
          }
        } catch (error) {
          setSettingsNote({ ok: false, text: String(error?.message ?? error) });
        } finally {
          setBusySettings(false);
        }
      };

      const providerOptions = uniqueSorted([
        ...catalog.providers.map((entry) => String(entry.id ?? '')),
        ...catalog.models.map((entry) => String(entry.provider ?? '')),
        draft.provider,
        initial.provider,
      ]);
      const modelOptions = uniqueSorted(
        catalog.models
          .filter((entry) => draft.provider === '' || String(entry.provider ?? '') === draft.provider)
          .map((entry) => String(entry.id ?? ''))
          .concat(draft.model, initial.model),
      );
      const effortOptions = uniqueSorted(
        catalog.models
          .filter((entry) => draft.model === '' || String(entry.id ?? '') === draft.model)
          .flatMap((entry) => (Array.isArray(entry.efforts) ? entry.efforts.map(String) : []))
          .concat(draft.reasoningEffort),
      );

      const effectiveProvider = initial.provider || hostDefault?.provider || '';
      const effectiveModel = initial.model || hostDefault?.model || '';
      const effectiveText =
        effectiveProvider === '' && effectiveModel === ''
          ? t('model.inherit')
          : `${effectiveProvider}/${effectiveModel}`;
      const overrideText = initial.provider !== '' || initial.model !== '' ? t('model.override') : t('model.sameAsDefault');

      const field = (labelText, hintText, inputProps) =>
        h(
          'label',
          { className: 'olx-field' },
          h('span', { className: 'olx-field-label' }, labelText),
          h('input', { className: 'olx-input', autoComplete: 'off', ...inputProps }),
          hintText ? h('span', { className: 'olx-hint' }, hintText) : null,
        );

      const checkbox = (checked, labelText, hintText, onChange) =>
        h(
          'label',
          { className: 'olx-check' },
          h('input', { type: 'checkbox', checked, onChange: (event) => onChange(event.target.checked) }),
          h(
            'span',
            { className: 'olx-check-text' },
            h('span', null, labelText),
            hintText ? h('span', { className: 'olx-hint' }, hintText) : null,
          ),
        );

      return h(
        'div',
        { className: 'olx-root' },
        h('h3', { className: 'olx-title' }, t('section.title')),
        h('p', { className: 'olx-intro' }, t('form.intro')),
        h(
          'div',
          { className: 'olx-card' },
          h(
            'div',
            { className: 'olx-row' },
            h('span', { className: 'olx-dot', 'data-state': state, 'aria-hidden': true }),
            h('span', null, stateLabel(t, state)),
            status?.configured ? h('span', { className: 'olx-label olx-value' }, status.hubUrl ?? '') : null,
          ),
          status?.bot
            ? h(
                'div',
                { className: 'olx-row' },
                h('span', { className: 'olx-label' }, t('status.bot')),
                h('span', { className: 'olx-value' }, String(status.bot.name ?? status.bot.id ?? '')),
              )
            : null,
          status?.lastError
            ? h(
                'div',
                { className: 'olx-row' },
                h('span', { className: 'olx-label' }, t('status.lastError')),
                h('span', { className: 'olx-value' }, String(status.lastError)),
              )
            : null,
          Array.isArray(status?.sessions) && status.sessions.length > 0
            ? h(
                'div',
                { className: 'olx-row' },
                h('span', { className: 'olx-label' }, t('status.sessions')),
                h(
                  'ul',
                  { className: 'olx-list' },
                  status.sessions.map((session) =>
                    h(
                      'li',
                      { key: session.key, className: 'olx-value' },
                      `${session.kind === 'group' ? t('status.group') : t('status.direct')} ${session.peerId}`,
                    ),
                  ),
                ),
              )
            : null,
          loadError ? h('p', { className: 'olx-note olx-note--error' }, loadError) : null,
          h(
            'div',
            { className: 'olx-actions' },
            h(
              'button',
              {
                type: 'button',
                className: 'olx-btn',
                onClick: () => setTick((value) => value + 1),
              },
              t('form.refresh'),
            ),
          ),
        ),
        !status?.configured && status !== undefined
          ? h('p', { className: 'olx-hint' }, t('form.unconfiguredHint'))
          : null,
        h(
          'form',
          { className: 'olx-card', onSubmit },
          h(
            'label',
            { className: 'olx-field' },
            h('span', { className: 'olx-field-label' }, t('form.hubUrl')),
            h('input', {
              className: 'olx-input',
              type: 'url',
              value: hubUrl,
              placeholder: 'https://hub.openilink.com',
              onChange: (event) => setHubUrl(event.target.value),
              autoComplete: 'off',
            }),
            h('span', { className: 'olx-hint' }, t('form.hubUrlHint')),
          ),
          h(
            'label',
            { className: 'olx-field' },
            h('span', { className: 'olx-field-label' }, t('form.appToken')),
            h('input', {
              className: 'olx-input',
              type: 'password',
              value: appToken,
              placeholder: status?.configured ? '••••••••' : 'app_...',
              onChange: (event) => setAppToken(event.target.value),
              autoComplete: 'off',
            }),
            h('span', { className: 'olx-hint' }, t('form.appTokenHint')),
          ),
          h(
            'div',
            { className: 'olx-actions' },
            h(
              'button',
              { type: 'submit', className: 'olx-btn olx-btn--primary', disabled: busy || !dirty },
              busy ? t('form.saving') : t('form.save'),
            ),
            note ? h('p', { className: `olx-note ${note.ok ? 'olx-note--ok' : 'olx-note--error'}` }, note.text) : null,
          ),
        ),
        h(
          'form',
          { className: 'olx-card', onSubmit: onSaveSettings },
          h('h4', { className: 'olx-card-title' }, t('model.title')),
          h(
            'div',
            { className: 'olx-row' },
            h('span', { className: 'olx-label' }, t('model.current')),
            h('span', { className: 'olx-value' }, effectiveText),
            h('span', { className: 'olx-label' }, overrideText),
          ),
          h(
            'div',
            { className: 'olx-grid' },
            field(t('model.provider'), t('model.providerHint'), {
              value: draft.provider,
              list: 'olx-provider-options',
              placeholder: t('model.inherit'),
              onChange: (event) => setDraft((current) => ({ ...current, provider: event.target.value })),
            }),
            field(t('model.model'), t('model.modelHint'), {
              value: draft.model,
              list: 'olx-model-options',
              placeholder: t('model.inherit'),
              onChange: (event) => setDraft((current) => ({ ...current, model: event.target.value })),
            }),
          ),
          h('datalist', { id: 'olx-provider-options' }, providerOptions.map((value) => h('option', { key: value, value }))),
          h('datalist', { id: 'olx-model-options' }, modelOptions.map((value) => h('option', { key: value, value }))),
          field(t('model.effort'), t('model.effortHint'), {
            value: draft.reasoningEffort,
            list: 'olx-effort-options',
            placeholder: hostDefault?.reasoningEffort ?? '',
            onChange: (event) => setDraft((current) => ({ ...current, reasoningEffort: event.target.value })),
          }),
          h('datalist', { id: 'olx-effort-options' }, effortOptions.map((value) => h('option', { key: value, value }))),
          checkbox(draft.showReasoning, t('model.showReasoning'), t('model.showReasoningHint'), (checked) =>
            setDraft((current) => ({ ...current, showReasoning: checked })),
          ),
          checkbox(draft.showTools, t('model.showTools'), t('model.showToolsHint'), (checked) =>
            setDraft((current) => ({ ...current, showTools: checked })),
          ),
          h(
            'div',
            { className: 'olx-actions' },
            h(
              'button',
              { type: 'submit', className: 'olx-btn olx-btn--primary', disabled: busySettings || !settingsDirty },
              busySettings ? t('model.saving') : t('model.save'),
            ),
            settingsNote
              ? h(
                  'p',
                  { className: `olx-note ${settingsNote.ok ? 'olx-note--ok' : 'olx-note--error'}` },
                  settingsNote.text,
                )
              : null,
          ),
        ),
      );
    }

    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, DICTS), 'openilink: dictionaries');
      const t = ctx.locale.bind(NS);
      const disposers = [];
      disposers.push(
        ctx.slots.inject('settings.section', () =>
          ctx.slots.register(
            {
              name: 'settings.section',
              id: 'openilink',
              order: 8,
              label: () => t('section.title'),
            },
            function OpeniLinkSettingsSection() {
              useLocaleRevision(ctx);
              return h(LocaleContext.Provider, { value: { locale: readLocale(ctx), t } }, h(Panel));
            },
          ),
        ),
      );
      ctx.effect(() => () => {
        for (const dispose of disposers.reverse()) dispose();
      }, 'openilink: slots');
    }

    return {
      inject: ['slots', 'locale'],
      apply,
      name: 'openilink-client',
    };
  },
});
