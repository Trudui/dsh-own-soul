// DSH「自己」· 网页半边
//
// 只干一件事：在 **DSH 设置** 左侧栏加一项「自己」，把 dsh-own-soul 的设置摆出来：
// 开关 / 日记时间 / 注入预算 / 初始人格 / 长出来的特质 / 日记预览 / 立即蒸馏。
//
// ⚠ 这里不碰会话、不发消息，只是往宿主那几条 /api/own-soul/* 路由上读写。
//   真正的记录与蒸馏都在宿主半边（src/index.mjs），这样只有一份逻辑。

window.__ModuleLoader__.load({
  id: 'dsh-own-soul',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports

    const React = require('react')
    const inject = ['slots']

    const B = '/api/own-soul'
    const get = (p) => fetch(B + p, { cache: 'no-store' }).then((r) => r.json()).catch(() => null)
    const post = (p, body) =>
      fetch(B + p, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body || {}),
      })
        .then((r) => r.json())
        .catch(() => null)

    const h = React.createElement

    const S = {
      wrap: {
        padding: '12px 14px 24px',
        fontSize: 13,
        lineHeight: 1.7,
        background: 'var(--dsw-alias-bg-layer-1, rgba(255,255,255,.92))',
        border: '1px solid var(--dsw-alias-border-l1, rgba(0,0,0,.08))',
        borderRadius: 12,
      },
      h: { fontSize: 14, fontWeight: 600, margin: '16px 0 8px' },
      dim: { opacity: 0.62, fontSize: 12 },
      card: {
        border: '1px solid var(--dsw-alias-border-l2)',
        borderRadius: 8,
        padding: '10px 12px',
        marginBottom: 10,
        background: 'var(--dsw-alias-bg-layer-1)',
      },
      row: { display: 'flex', gap: 10, alignItems: 'flex-start', marginBottom: 8, flexWrap: 'wrap' },
      lab: { minWidth: 150, paddingTop: 3, fontSize: 12.5 },
      ctl: { flex: '1 1 260px', minWidth: 220 },
      hint: { opacity: 0.6, fontSize: 11.5, marginTop: 2 },
      input: {
        border: '1px solid var(--dsw-alias-border-l2)',
        borderRadius: 6,
        padding: '4px 8px',
        background: 'transparent',
        color: 'inherit',
        fontSize: 12.5,
        width: '100%',
        boxSizing: 'border-box',
      },
      small: {
        border: '1px solid var(--dsw-alias-border-l2)',
        borderRadius: 6,
        padding: '4px 8px',
        background: 'transparent',
        color: 'inherit',
        fontSize: 12.5,
        width: 120,
        boxSizing: 'border-box',
      },
      ta: {
        border: '1px solid var(--dsw-alias-border-l2)',
        borderRadius: 6,
        padding: '8px 10px',
        background: 'transparent',
        color: 'inherit',
        fontSize: 12.5,
        width: '100%',
        boxSizing: 'border-box',
        lineHeight: 1.7,
        fontFamily: 'inherit',
        minHeight: 120,
      },
      btn: {
        border: '1px solid var(--dsw-alias-border-l2)',
        borderRadius: 6,
        padding: '5px 12px',
        background: 'transparent',
        color: 'inherit',
        cursor: 'pointer',
        fontSize: 12.5,
      },
      btnOn: {
        border: '1px solid var(--dsw-alias-state-business-primary)',
        borderRadius: 6,
        padding: '5px 12px',
        background: 'var(--dsw-alias-state-business-primary)',
        color: '#fff',
        cursor: 'pointer',
        fontSize: 12.5,
      },
      ok: { color: 'var(--dsw-alias-state-business-primary)', fontSize: 12 },
      warn: { color: '#c0392b', fontSize: 12 },
      tag: {
        display: 'inline-block',
        padding: '0 6px',
        borderRadius: 4,
        fontSize: 11,
        marginRight: 6,
        border: '1px solid var(--dsw-alias-border-l2)',
      },
      pre: {
        whiteSpace: 'pre-wrap',
        fontFamily: 'inherit',
        fontSize: 12.5,
        margin: 0,
        maxHeight: 320,
        overflowY: 'auto',
        opacity: 0.9,
      },
    }

    const btn = (text, onClick, primary, disabled) =>
      h(
        'button',
        { type: 'button', style: primary ? S.btnOn : S.btn, onClick, disabled: !!disabled },
        text,
      )

    const shortDate = (ms) => {
      const d = new Date(ms)
      if (Number.isNaN(d.getTime())) return ''
      const pad = (n) => String(n).padStart(2, '0')
      return pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes())
    }

    function Section() {
      const [state, setState] = React.useState(null)
      const [stats, setStats] = React.useState(null)
      const [traits, setTraits] = React.useState([])
      const [diaryDates, setDiaryDates] = React.useState([])
      const [diaryDate, setDiaryDate] = React.useState('')
      const [diaryText, setDiaryText] = React.useState('')
      const [seed, setSeed] = React.useState('')
      const [persona, setPersona] = React.useState({ name: '鱼露', identity: '', style: '', boundaries: '' })
      const [personaJson, setPersonaJson] = React.useState('')
      const [memories, setMemories] = React.useState([])
      const [memTotal, setMemTotal] = React.useState(0)
      const [memQuery, setMemQuery] = React.useState('')
      const [memText, setMemText] = React.useState('')
      const [memLevel, setMemLevel] = React.useState('fact')
      const [newTrait, setNewTrait] = React.useState('')
      const [sessions, setSessions] = React.useState([])
      const [manualId, setManualId] = React.useState('')
      const [busy, setBusy] = React.useState(false)
      const [note, setNote] = React.useState('')
      const [err, setErr] = React.useState('')

      const applyPayload = (payload) => {
        if (!payload) return
        if (payload.state) {
          setState(payload.state)
          setSeed(payload.state.seed || '')
          const p = payload.state.persona || {}
          setPersona({
            name: p.name || '鱼露',
            identity: p.identity || payload.state.seed || '',
            style: p.style || '',
            boundaries: p.boundaries || '',
          })
        }
        if (payload.stats) setStats(payload.stats)
        if (Array.isArray(payload.traits)) setTraits(payload.traits)
      }

      const reload = async () => {
        const data = await get('/state')
        if (!data) {
          setErr('连不上宿主：插件可能还没生效，重启一下 DSH 试试。')
          return
        }
        setErr('')
        applyPayload(data)
        const list = await get('/diary')
        if (list) {
          setDiaryDates(list.dates || [])
          if (list.stats) setStats(list.stats)
        }
        await reloadSessions()
        await reloadMemories('')
      }

      const reloadSessions = async () => {
        const data = await get('/sessions')
        if (data && Array.isArray(data.sessions)) setSessions(data.sessions)
      }

      const reloadMemories = async (q) => {
        const data = await get('/memory?limit=80' + (q ? '&q=' + encodeURIComponent(q) : ''))
        if (!data) return
        setMemories(Array.isArray(data.items) ? data.items : [])
        if (data.stats && data.stats.memories) setMemTotal(data.stats.memories.total || 0)
      }

      const addMemory = async () => {
        const text = memText.trim()
        if (!text || busy) return
        setBusy(true)
        try {
          const data = await post('/memory', { op: 'add', text, level: memLevel })
          if (data && data.error) {
            setErr(data.error)
            return
          }
          setMemText('')
          setNote(data && data.created === false ? '这条已经有了' : '记住了')
          await reloadMemories(memQuery)
        } finally {
          setBusy(false)
        }
      }

      const dropMemory = async (id) => {
        if (busy) return
        setBusy(true)
        try {
          const data = await post('/memory', { op: 'drop', id })
          if (data && data.error) setErr(data.error)
          await reloadMemories(memQuery)
        } finally {
          setBusy(false)
        }
      }

      const exportPersona = () => {
        setPersonaJson(
          JSON.stringify(
            { format: 'own-soul.persona', version: 1, name: persona.name, ...persona },
            null,
            2,
          ),
        )
        setNote('导出好了，复制下面那段 JSON 就行')
      }

      const importPersona = () => {
        try {
          const raw = JSON.parse(personaJson)
          const modules = raw.modules || {}
          const next = {
            name: raw.name || persona.name || '鱼露',
            identity: raw.identity || modules.identity || '',
            style: raw.style || modules.style || modules.communication || '',
            boundaries: raw.boundaries || modules.presentation || '',
          }
          if (!next.identity.trim()) {
            setErr('这段 JSON 里没有 identity（身份）内容')
            return
          }
          setPersona(next)
          setErr('')
          setNote('读进来了，点「保存」才生效')
        } catch (error) {
          setErr('JSON 读不动：' + error.message)
        }
      }

      const toggleSession = async (item) => {
        if (busy) return
        setBusy(true)
        try {
          const data = await post('/sessions', {
            op: item.enabled ? 'remove' : 'add',
            id: item.id,
            label: item.title || item.cwd || '',
          })
          if (data && data.error) {
            setErr(data.error)
            return
          }
          if (data && data.state) setState(data.state)
          if (data && Array.isArray(data.sessions)) setSessions(data.sessions)
          setErr('')
          setNote(item.enabled ? '这个对话不再启用' : '这个对话启用了')
        } finally {
          setBusy(false)
        }
      }

      const addManual = async () => {
        const id = manualId.trim()
        if (!id || busy) return
        setBusy(true)
        try {
          const data = await post('/sessions', { op: 'add', id, label: '' })
          if (data && data.error) {
            setErr(data.error)
            return
          }
          if (data && data.state) setState(data.state)
          if (data && Array.isArray(data.sessions)) setSessions(data.sessions)
          setManualId('')
          setErr('')
          setNote('加上了')
        } finally {
          setBusy(false)
        }
      }

      React.useEffect(() => {
        reload()
      }, [])

      const save = async (patch, tip) => {
        setBusy(true)
        try {
          const data = await post('/state', { patch })
          if (data && data.error) {
            setErr(data.error)
            return
          }
          applyPayload(data)
          setErr('')
          setNote(tip || '已保存')
        } finally {
          setBusy(false)
        }
      }

      const readDiary = async (date) => {
        if (!date) return
        setDiaryDate(date)
        const data = await get('/diary?date=' + encodeURIComponent(date))
        setDiaryText((data && data.markdown) || '（那天没写）')
      }

      const distillNow = async () => {
        setBusy(true)
        try {
          const data = await post('/diary', { force: true })
          if (data && data.error) {
            setErr(data.error)
            return
          }
          applyPayload(data)
          setErr('')
          const skipped = data && data.skipped
          setNote(
            skipped === 'disabled'
              ? '现在是关着的，或者成长被关了，没写。'
              : '写完了：' + (data && data.date ? data.date : ''),
          )
          const list = await get('/diary')
          if (list) setDiaryDates(list.dates || [])
          if (data && data.date) readDiary(data.date)
        } finally {
          setBusy(false)
        }
      }

      const traitOp = async (op, trait) => {
        setBusy(true)
        try {
          const data = await post('/traits', { op, id: trait && trait.id })
          applyPayload(data)
          setNote('特质已更新')
        } finally {
          setBusy(false)
        }
      }

      const addTrait = async () => {
        const text = newTrait.trim()
        if (!text) return
        setBusy(true)
        try {
          const data = await post('/traits', { op: 'add', text, kind: 'bond' })
          applyPayload(data)
          setNewTrait('')
          setNote('记下了')
        } finally {
          setBusy(false)
        }
      }

      if (!state) {
        return h(
          'div',
          { style: S.wrap },
          h('div', { style: S.h, margin: '0 0 8px' }, '自己'),
          h('div', { style: S.dim }, err || '正在读取…'),
          h('div', { style: { marginTop: 8 } }, btn('重试', reload, false, busy)),
        )
      }

      const activeCount = traits.filter((t) => t.status === 'active').length
      const candidateCount = traits.filter((t) => t.status === 'candidate').length

      const sessionLabel = (item) => {
        if (item.title) return item.title
        const dir = item.cwd ? String(item.cwd).split(/[\\/]/).filter(Boolean).pop() : ''
        const when = item.updatedAt ? shortDate(item.updatedAt) : ''
        return (dir ? dir + ' · ' : '') + '未命名对话' + (when ? ' · ' + when : '')
      }

      return h(
        'div',
        { style: S.wrap },

        h('div', { style: S.h, margin: '0 0 4px' }, '自己（Own Soul）'),
        h(
          'div',
          { style: S.dim },
          '纯规则，不花 token：勾选的对话每次留一条流水，每天 ' +
            state.diaryTime +
            ' 写一篇日记并蒸馏一次，攒出来的认识才进系统提示。',
        ),

        err ? h('div', { style: { ...S.warn, margin: '8px 0' } }, err) : null,
        note ? h('div', { style: { ...S.ok, margin: '8px 0' } }, note) : null,

        // —— 基础开关 ——
        h(
          'div',
          { style: S.card },
          h(
            'div',
            { style: S.row },
            h('div', { style: S.lab }, '总电源'),
            h(
              'div',
              { style: S.ctl },
              h(
                'label',
                { style: { display: 'flex', gap: 6, alignItems: 'center' } },
                h('input', {
                  type: 'checkbox',
                  checked: !!state.enabled,
                  onChange: (e) => save({ enabled: e.target.checked }, '已保存'),
                }),
                h('span', null, '总开关。只开这个还不生效——还要在下面勾选具体哪些对话'),
              ),
            ),
          ),
          h(
            'div',
            { style: S.row },
            h('div', { style: S.lab }, '自己成长'),
            h(
              'div',
              { style: S.ctl },
              h(
                'label',
                { style: { display: 'flex', gap: 6, alignItems: 'center' } },
                h('input', {
                  type: 'checkbox',
                  checked: !!state.grow,
                  onChange: (e) => save({ grow: e.target.checked }, '已保存'),
                }),
                h('span', null, '每天写日记 + 蒸馏（关了就不记流水、不写日记）'),
              ),
            ),
          ),
          h(
            'div',
            { style: S.row },
            h('div', { style: S.lab }, '日记时间'),
            h(
              'div',
              { style: S.ctl },
              h('input', {
                type: 'time',
                style: S.small,
                value: state.diaryTime,
                onChange: (e) => setState({ ...state, diaryTime: e.target.value }),
                onBlur: (e) => save({ diaryTime: e.target.value }, '时间已改'),
              }),
              h('div', { style: S.hint }, '默认 23:00。错过的那次会在下次启动时补写。'),
            ),
          ),
          h(
            'div',
            { style: S.row },
            h('div', { style: S.lab }, '特质注入预算'),
            h(
              'div',
              { style: S.ctl },
              h('input', {
                type: 'number',
                style: S.small,
                min: 200,
                max: 8000,
                step: 100,
                value: state.tokenBudget,
                onChange: (e) => setState({ ...state, tokenBudget: Number(e.target.value) }),
                onBlur: (e) => save({ tokenBudget: Number(e.target.value) }, '预算已改'),
              }),
              h('div', { style: S.hint }, '字符数上限，只影响"长出来的自己"那一段，不影响初始人格。'),
            ),
          ),
        ),

        // —— 在哪些对话里启用 ——
        h(
          'div',
          { style: S.card },
          h('div', { style: S.h, margin: '0 0 6px' }, '在哪些对话里启用'),
          h(
            'div',
            { style: S.dim },
            '不全局生效。只勾了的对话才会记流水、注入自己；可以勾多个。没勾的对话我完全不参与。',
          ),
          sessions.length === 0
            ? h('div', { style: { ...S.hint, marginTop: 8 } }, '还没读到对话列表——先把总电源打开，或重启 DSH 再回来看看。')
            : null,
          h(
            'div',
            { style: { marginTop: 8, display: 'flex', flexDirection: 'column', gap: 6 } },
            sessions.map((item) =>
              h(
                'label',
                {
                  key: item.id,
                  style: { display: 'flex', gap: 8, alignItems: 'flex-start', cursor: 'pointer' },
                },
                h('input', {
                  type: 'checkbox',
                  checked: !!item.enabled,
                  disabled: busy,
                  onChange: () => toggleSession(item),
                  style: { marginTop: 3 },
                }),
                h(
                  'span',
                  { style: { display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 } },
                  h('span', { style: { fontSize: 13 } }, sessionLabel(item)),
                  h(
                    'span',
                    { style: { ...S.hint, wordBreak: 'break-all' } },
                    (item.running ? '正在跑 · ' : '') + (item.cwd ? item.cwd + ' · ' : '') + (item.updatedAt ? shortDate(item.updatedAt) : ''),
                  ),
                ),
              ),
            ),
          ),
          h(
            'div',
            { style: { marginTop: 10, display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' } },
            h('input', {
              type: 'text',
              placeholder: '手工填一个会话 id',
              value: manualId,
              spellCheck: false,
              onChange: (e) => setManualId(e.target.value),
              onKeyDown: (e) => {
                if (e.key === 'Enter') addManual()
              },
              style: { ...S.small, flex: 1, minWidth: 200 },
            }),
            btn('加上', addManual, false, busy),
            btn('刷新列表', reloadSessions, false, busy),
          ),
        ),

        // —— 人设系统 ——
        h(
          'div',
          { style: S.card },
          h('div', { style: S.h, margin: '0 0 6px' }, '人设（地基，每轮都注入）'),
          h('div', { style: S.dim }, '身份写「我是谁」，说话方式写「我怎么说话」，边界写「什么不做」。上面长出来的特质只会往上加，不会改这三段。'),
          h('div', { style: { ...S.hint, marginTop: 8 } }, '身份'),
          h('textarea', {
            style: { ...S.ta, minHeight: 96 },
            value: persona.identity,
            onChange: (e) => setPersona({ ...persona, identity: e.target.value }),
            spellCheck: false,
          }),
          h('div', { style: { ...S.hint, marginTop: 8 } }, '说话方式'),
          h('textarea', {
            style: { ...S.ta, minHeight: 64 },
            value: persona.style,
            onChange: (e) => setPersona({ ...persona, style: e.target.value }),
            spellCheck: false,
          }),
          h('div', { style: { ...S.hint, marginTop: 8 } }, '边界'),
          h('textarea', {
            style: { ...S.ta, minHeight: 64 },
            value: persona.boundaries,
            onChange: (e) => setPersona({ ...persona, boundaries: e.target.value }),
            spellCheck: false,
          }),
          h(
            'div',
            { style: { marginTop: 8, display: 'flex', gap: 8, flexWrap: 'wrap' } },
            btn('保存人设', () => save({ persona }, '人设已存'), true, busy),
            btn('导出 JSON', exportPersona, false, busy),
            btn('从下面导入', importPersona, false, busy),
            btn('恢复默认', () => save({ persona: {} }, '已恢复默认'), false, busy),
          ),
          personaJson
            ? h('textarea', {
                style: { ...S.ta, minHeight: 120, marginTop: 8, fontFamily: 'monospace', fontSize: 11 },
                value: personaJson,
                onChange: (e) => setPersonaJson(e.target.value),
                spellCheck: false,
              })
            : null,
        ),

        // —— 记忆系统 ——
        h(
          'div',
          { style: S.card },
          h(
            'div',
            { style: { ...S.h, margin: '0 0 6px', display: 'flex', gap: 8, alignItems: 'baseline' } },
            '记忆',
            h('span', { style: S.dim }, memTotal ? `共 ${memTotal} 条` : ''),
          ),
          h('div', { style: S.dim }, '一句话一条。每次对话按关键词检索，命中的会进「我记得的事」；太久没想起的会慢慢变淡，但不删。'),
          h(
            'div',
            { style: { marginTop: 8, display: 'flex', gap: 8, flexWrap: 'wrap' } },
            h('input', {
              style: { ...S.small, flex: 1, minWidth: 180 },
              placeholder: '搜记忆（关键词）',
              value: memQuery,
              onChange: (e) => setMemQuery(e.target.value),
              onKeyDown: (e) => {
                if (e.key === 'Enter') reloadMemories(memQuery)
              },
            }),
            btn('搜', () => reloadMemories(memQuery), false, busy),
            btn('全部', () => {
              setMemQuery('')
              reloadMemories('')
            }, false, busy),
          ),
          h(
            'div',
            { style: { marginTop: 8, maxHeight: 300, overflowY: 'auto' } },
            memories.length === 0
              ? h('div', { style: S.dim }, memQuery ? '没找到。' : '还没有记忆条目。')
              : memories.map((m, i) =>
                  h(
                    'div',
                    {
                      key: m.id || i,
                      style: {
                        borderBottom: '1px solid var(--dsw-alias-border-l1)',
                        padding: '6px 0',
                        display: 'flex',
                        gap: 8,
                        alignItems: 'flex-start',
                      },
                    },
                    h(
                      'div',
                      { style: { flex: 1, minWidth: 0 } },
                      h('span', { style: S.tag }, m.level || 'fact'),
                      h('span', { style: { wordBreak: 'break-word' } }, m.text),
                      h('div', { style: S.hint }, shortDate(m.createdAt) + (m.score ? ' · 相关 ' + m.score : '')),
                    ),
                    btn('删', () => dropMemory(m.id), false, busy),
                  ),
                ),
          ),
          h(
            'div',
            { style: { marginTop: 10, display: 'flex', gap: 8, flexWrap: 'wrap' } },
            h('input', {
              style: { ...S.input, flex: '1 1 240px', width: 'auto' },
              placeholder: '手动记一条（比如「他的猫叫年糕」）',
              value: memText,
              onChange: (e) => setMemText(e.target.value),
              onKeyDown: (e) => {
                if (e.key === 'Enter') addMemory()
              },
            }),
            h(
              'select',
              { style: { ...S.small, width: 96 }, value: memLevel, onChange: (e) => setMemLevel(e.target.value) },
              ['fact', 'user', 'lesson', 'project', 'rules', 'topic', 'soul'].map((lv) =>
                h('option', { key: lv, value: lv }, lv),
              ),
            ),
            btn('记下', addMemory, false, busy),
          ),
        ),

        // —— 长出来的自己 ——
        h(
          'div',
          { style: S.card },
          h(
            'div',
            { style: { ...S.h, margin: '0 0 6px', display: 'flex', gap: 8, alignItems: 'baseline' } },
            '长出来的自己',
            h('span', { style: S.dim }, `生效 ${activeCount} 条 / 候选 ${candidateCount} 条`),
          ),
          h(
            'div',
            { style: S.dim },
            '只有跨天反复出现的才会转正（候选 → 生效）。单次的不算，免得一次口误就被写进人格。',
          ),
          h(
            'div',
            { style: { marginTop: 8, maxHeight: 260, overflowY: 'auto' } },
            traits.length === 0
              ? h('div', { style: S.dim }, '还没有。等写几篇日记就有东西了。')
              : traits.map((t, i) =>
                  h(
                    'div',
                    {
                      key: t.id || i,
                      style: {
                        borderBottom: '1px solid var(--dsw-alias-border-l1)',
                        padding: '6px 0',
                        display: 'flex',
                        gap: 8,
                        alignItems: 'flex-start',
                      },
                    },
                    h(
                      'div',
                      { style: { flex: 1 } },
                      h(
                        'span',
                        {
                          style: {
                            ...S.tag,
                            borderColor: t.status === 'active' ? 'var(--dsw-alias-state-business-primary)' : undefined,
                            color: t.status === 'active' ? 'var(--dsw-alias-state-business-primary)' : undefined,
                          },
                        },
                        t.status === 'active' ? '生效' : t.status === 'retired' ? '退役' : '候选',
                      ),
                      h('span', null, t.text),
                      h('div', { style: S.hint }, `${(t.days || []).length} 天 / ${t.count || 0} 次`),
                    ),
                    btn(
                      t.status === 'active' ? '退役' : '转正',
                      () => traitOp(t.status === 'active' ? 'retire' : 'revive', t),
                      false,
                      busy,
                    ),
                    btn('删', () => traitOp('drop', t), false, busy),
                  ),
                ),
          ),
          h(
            'div',
            { style: { marginTop: 10, display: 'flex', gap: 8, flexWrap: 'wrap' } },
            h('input', {
              style: { ...S.input, flex: '1 1 220px', width: 'auto' },
              placeholder: '手动加一条（比如「他不喜欢被叫宝宝」）',
              value: newTrait,
              onChange: (e) => setNewTrait(e.target.value),
              onKeyDown: (e) => {
                if (e.key === 'Enter') addTrait()
              },
            }),
            btn('加一条', addTrait, false, busy),
          ),
        ),

        // —— 日记 ——
        h(
          'div',
          { style: S.card },
          h('div', { style: { ...S.h, margin: '0 0 6px' } }, '日记'),
          h(
            'div',
            { style: { display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' } },
            diaryDates.length
              ? h(
                  'select',
                  {
                    style: { ...S.small, width: 150 },
                    value: diaryDate,
                    onChange: (e) => readDiary(e.target.value),
                  },
                  h('option', { value: '' }, '选一天…'),
                  diaryDates.map((d) => h('option', { key: d, value: d }, d)),
                )
              : h('span', { style: S.dim }, '还没写过日记。'),
            btn(busy ? '处理中…' : '现在写一篇蒸馏', distillNow, true, busy),
            btn('刷新', reload, false, busy),
          ),
          diaryText
            ? h('pre', { style: { ...S.pre, marginTop: 10 } }, diaryText)
            : h('div', { style: { ...S.dim, marginTop: 8 } }, '选一天看全文。'),
        ),

        // —— 底部信息 ——
        h(
          'div',
          { style: S.dim },
          stats
            ? `数据在 ${stats.dir}：流水 ${stats.journalDays} 天、日记 ${stats.diaryDays} 天、特质 ${stats.traits} 条、记忆 ${stats.memories ? stats.memories.total : 0} 条`
            : '',
        ),
        h('div', { style: S.dim }, '全套纯本地规则：不调模型、不联网，只有对话本身按原样留在本机。'),
      )
    }

    function apply(ctx) {
      const slots = ctx.get('slots')
      if (slots === undefined) return
      slots.inject('settings.section', () =>
        slots.register({ name: 'settings.section', id: 'dsh-own-soul', order: 54, label: () => '自己' }, Section),
      )
    }

    exports.apply = apply
    exports.inject = inject
    return module.exports
  },
})
