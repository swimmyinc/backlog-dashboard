  // ---------------- データ ----------------
  // ---------------- 共有ストレージ(クライアント一覧をチーム全員で共有) ----------------
  // デプロイしたclients-store WorkerのURLをここに設定してください。
  // 例: "https://clients-store.xxxx.workers.dev/clients"
  const CLIENTS_API_URL = "";

  let clients = [];
  let backlogSettings = null;

  async function loadClientsFromServer(){
    if(!CLIENTS_API_URL){
      return;
    }
    try{
      const res = await fetch(CLIENTS_API_URL);
      if(!res.ok) throw new Error('HTTP ' + res.status);
      const body = await res.json();
      clients = Array.isArray(body.clients) ? body.clients.map(clientForStorage) : [];
    }catch(err){
      console.error('クライアント一覧の読み込みに失敗しました', err);
      showSyncBanner('クライアント一覧の読み込みに失敗しました。共有ストレージへの接続を確認してください。(' + err.message + ')', true);
    }
  }

  let saveTimer = null;
  async function saveClientsToServer(){
    if(!CLIENTS_API_URL) return;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(async () => {
      try{
        const res = await fetch(CLIENTS_API_URL, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ clients: clients.map(clientForStorage) }),
        });
        if(!res.ok) throw new Error('HTTP ' + res.status);
      }catch(err){
        console.error('クライアント一覧の保存に失敗しました', err);
        showSyncBanner('保存に失敗しました。ネットワークを確認して、もう一度操作してください。(' + err.message + ')', true);
      }
    }, 300);
  }

  function showSyncBanner(message, isError){
    let banner = document.getElementById('syncBanner');
    if(!banner){
      banner = document.createElement('div');
      banner.id = 'syncBanner';
      banner.className = 'notice';
      document.querySelector('.app').prepend(banner);
    }
    banner.textContent = message;
    banner.style.background = isError ? 'var(--red-soft)' : 'var(--amber-soft)';
    banner.style.borderColor = isError ? 'var(--red)' : 'var(--amber)';
    banner.style.color = isError ? 'var(--red)' : '#7A5A1E';
  }

  let selectedClientId = null;
  let activeTab = "completed";
  let filterText = "";
  let filterDirector = "";

  // サンプル課題プール(クライアントごとに軽く配分を変える)
  const issuePool = [
    { key:"142", summary:"商品マスタ画面の表示崩れ修正", status:"完了", type:"バグ", est:4, act:3.5 },
    { key:"145", summary:"在庫連携バッチのエラー調査", status:"完了", type:"保守対応", est:6, act:7 },
    { key:"148", summary:"月次レポート出力項目の追加", status:"完了", type:"機能追加", est:5, act:4.5 },
    { key:"151", summary:"ログイン画面のアクセシビリティ改善", status:"完了", type:"改善", est:3, act:2.5 },
    { key:"153", summary:"検索APIのレスポンス遅延対応", status:"完了", type:"バグ", est:4, act:2 },
    { key:"156", summary:"権限管理画面のリニューアル", status:"処理中", type:"機能追加", est:8, act:3 },
    { key:"158", summary:"通知メールテンプレートの整理", status:"未対応", type:"改善", est:3, act:0 },
    { key:"159", summary:"CSVエクスポートの文字化け調査", status:"処理中", type:"バグ", est:3, act:1 },
    { key:"162", summary:"発注書PDFの自動生成", status:"完了", type:"発注", est:5, act:5 },
  ];

  function hashSeed(str){ let h=0; for(let i=0;i<str.length;i++){ h=(h*31+str.charCodeAt(i))>>>0; } return h; }

  // 完了/処理中(対応中)/未対応 の3分類だけを対象にする
  function splitByStatus(issues){
    return {
      completed: issues.filter(i => i.status === '完了'),
      inProgress: issues.filter(i => i.status === '処理中'),
      notStarted: issues.filter(i => i.status === '未対応'),
    };
  }

  function getSampleIssuesForClient(client){
    const seed = hashSeed(client.id + client.from + client.to);
    const items = issuePool.filter(i => i.type !== "発注").filter((_, idx) => (seed + idx) % 3 !== 0);
    const withKey = items.map(i => ({ ...i, issueKey: client.name.slice(0,4).toUpperCase() + "-" + i.key }));
    return splitByStatus(withKey);
  }

  // 実データ(Backlogから取得済み)があればそれを、なければサンプルを返す
  function getIssuesForClient(client){
    return client.data || getSampleIssuesForClient(client);
  }

  // 共有保存には画面で扱う項目だけを含め、旧データのAPIキーを引き継がない。
  function clientForStorage(client){
    const { id, name, director, spaceUrl, projectId, monthlyHours, carryOverHours,
      extraHours, from, to, synced, data, history } = client;
    return { id, name, director, spaceUrl, projectId, monthlyHours, carryOverHours,
      extraHours, from, to, synced, data, history: history || [] };
  }

  // APIの認証情報はWorkerだけが扱う。
  async function requestApi(path){
    const res = await fetch(path, { credentials: 'same-origin' });
    let body;
    try{
      body = await res.json();
    }catch{
      throw new Error('接続を確認できません。画面を再読み込みしてください。');
    }
    if(!res.ok) throw new Error(body.error || '取得に失敗しました。');
    return body;
  }

  async function fetchFromBacklog(client, from, to){
    if(!backlogSettings || client.spaceUrl.replace(/\/$/, '') !== backlogSettings.spaceUrl){
      throw new Error('登録されている接続先を確認し、クライアントを編集してください。');
    }
    const params = new URLSearchParams({ projectId: client.projectId, from, to });
    return requestApi('/api/backlog/issues?' + params);
  }

  // 取得した課題名や登録内容をHTMLとして実行させない。
  function escapeHtml(value){
    return String(value ?? '').replace(/[&<>"']/g, char => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[char]));
  }

  function summarizeIssues(list){
    return {
      count: list.length,
      totalEst: Math.round(list.reduce((s,i)=>s+i.est,0)*100)/100,
      totalAct: Math.round(list.reduce((s,i)=>s+i.act,0)*100)/100,
      issues: list,
    };
  }

  // 完了・対応中(処理中)の工数だけを残工数から差し引く。未対応はまだ着手前なので差し引かない。
  function getClientTotals(client){
    const { completed, inProgress, notStarted } = getIssuesForClient(client);
    const completedSum = summarizeIssues(completed);
    const inProgressSum = summarizeIssues(inProgress);
    const notStartedSum = summarizeIssues(notStarted);

    const est = Math.round((completedSum.totalEst + inProgressSum.totalEst) * 100) / 100;
    const act = Math.round((completedSum.totalAct + inProgressSum.totalAct) * 100) / 100;
    const capacity = Math.round((client.monthlyHours + client.carryOverHours + client.extraHours) * 100) / 100;
    const remaining = Math.round((capacity - est - act) * 100) / 100;

    return {
      completed: completedSum, inProgress: inProgressSum, notStarted: notStartedSum,
      est, act,
      actFromCompleted: completedSum.totalAct, actFromInProgress: inProgressSum.totalAct,
      capacity, remaining,
    };
  }

  function balClass(remaining, capacity){
    if(remaining <= 0) return 'bal-zero';
    if(remaining < capacity * 0.2) return 'bal-low';
    return 'bal-ok';
  }
  function statusClass(status){
    if(status === '完了') return 'st-完了';
    if(status === '処理中') return 'st-処理中';
    return 'st-未対応';
  }

  // ---------------- 描画 ----------------
  function populateDirectorFilter(){
    const select = document.getElementById('directorFilter');
    const current = select.value;
    const directors = Array.from(new Set(clients.map(c => c.director).filter(Boolean))).sort();
    select.innerHTML = '<option value="">すべての担当者</option>' +
      directors.map(d => `<option value="${escapeHtml(d)}">${escapeHtml(d)}</option>`).join('');
    if(directors.includes(current)) select.value = current;
  }

  function getFilteredClients(){
    return clients.filter(c => {
      const matchesText = !filterText || c.name.toLowerCase().includes(filterText.toLowerCase());
      const matchesDirector = !filterDirector || c.director === filterDirector;
      return matchesText && matchesDirector;
    });
  }

  function renderClientGrid(){
    populateDirectorFilter();
    const grid = document.getElementById('clientGrid');
    const empty = document.getElementById('clientEmpty');
    const list = getFilteredClients();
    if(clients.length === 0){
      grid.innerHTML = ''; empty.style.display = 'block';
      empty.textContent = 'クライアントがまだ登録されていません。「＋ クライアント追加」から登録してください。';
      return;
    }
    if(list.length === 0){
      grid.innerHTML = ''; empty.style.display = 'block';
      empty.textContent = '条件に一致するクライアントがありません。';
      return;
    }
    empty.style.display = 'none';
    grid.innerHTML = list.map(c => {
      const t = getClientTotals(c);
      const cls = balClass(t.remaining, t.capacity || 1);
      return `
        <div class="stub ${c.id === selectedClientId ? 'selected' : ''}" data-id="${escapeHtml(c.id)}">
          <div class="stub-head">
            <span class="name">${escapeHtml(c.name)}</span>
            <span class="tag ${c.synced ? '' : 'sample'}">${c.synced ? '同期済み' : '未取得'}</span>
          </div>
          <div class="stub-note"><span>Project #${escapeHtml(c.projectId)}</span><span>担当: ${escapeHtml(c.director || '未設定')}</span></div>
          <div class="stub-balance">
            <span class="num ${cls}">${t.remaining}</span>
            <span class="unit">h 残</span>
          </div>
          <div class="stub-meta"><span>想定工数 <b>${t.est}h</b></span><span>確定工数 <b>${t.act}h</b><span style="color:var(--ink-soft); font-weight:400;">(処理中含む)</span></span></div>
          <div class="stub-actions">
            <button class="ghost" data-detail="${escapeHtml(c.id)}">詳細を見る</button>
            <button class="ghost" data-edit="${escapeHtml(c.id)}">編集</button>
          </div>
        </div>
      `;
    }).join('');

    grid.querySelectorAll('[data-detail]').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        openDetail(btn.dataset.detail);
      });
    });
    grid.querySelectorAll('[data-edit]').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const c = clients.find(cl => cl.id === btn.dataset.edit);
        if(c) openClientModal(c);
      });
    });
    grid.querySelectorAll('.stub').forEach(el => {
      el.addEventListener('click', () => openDetail(el.dataset.id));
    });
  }

  function openDetail(clientId){
    selectedClientId = clientId;
    document.getElementById('listPage').style.display = 'none';
    document.getElementById('detailPage').style.display = 'block';
    renderDetail();
    window.scrollTo({ top: 0, behavior: 'instant' });
  }

  function backToList(){
    selectedClientId = null;
    document.getElementById('detailPage').style.display = 'none';
    document.getElementById('listPage').style.display = 'block';
    renderClientGrid();
    window.scrollTo({ top: 0, behavior: 'instant' });
  }
  document.getElementById('btnBackToList').addEventListener('click', backToList);

  function renderDetail(){
    const section = document.getElementById('detailSection');
    const client = clients.find(c => c.id === selectedClientId);
    if(!client){ backToList(); return; }
    const t = getClientTotals(client);
    const cls = balClass(t.remaining, t.capacity || 1);

    section.innerHTML = `
      <div class="detail-head">
        <div>
          <h2>${escapeHtml(client.name)} <button class="ghost" id="btnEditClient" style="font-size:11px; padding:3px 9px; margin-left:6px;">編集</button></h2>
          <div class="meta">${escapeHtml(client.spaceUrl)} ・ Project #${escapeHtml(client.projectId)} ・ 担当: ${escapeHtml(client.director || '未設定')}</div>
        </div>
        <div class="period-fields">
          <span>集計期間</span>
          <input type="text" id="detailFrom" value="${escapeHtml(client.from)}">
          <span>〜</span>
          <input type="text" id="detailTo" value="${escapeHtml(client.to)}">
          <button class="primary" id="btnFetch">この期間で取得</button>
        </div>
      </div>

      <div id="fetchStatus" style="font-size:12px; margin-bottom:14px;"></div>

      <div class="summary-bar" style="margin-bottom:20px;">
        <div class="item">
          <span class="label">残工数</span>
          <span class="val ${cls}">${t.remaining}<span class="unit">h</span></span>
        </div>
        <div class="item">
          <span class="label">想定工数</span>
          <span class="val">${t.est}<span class="unit">h</span></span>
          <span style="font-size:10px; color:var(--ink-soft);">未対応は含みません</span>
        </div>
        <div class="item">
          <span class="label">確定工数</span>
          <span class="val">${t.act}<span class="unit">h</span></span>
          <span style="font-size:10px; color:var(--ink-soft);">完了 ${t.actFromCompleted}h + 対応中 ${t.actFromInProgress}h</span>
        </div>
        <div class="item">
          <span class="label">今月使用可能</span>
          <span class="val">${t.capacity}<span class="unit">h</span></span>
        </div>
      </div>

      <nav class="tabs">
        <button class="tab-btn ${activeTab==='completed'?'active':''}" data-tab="completed">完了タスク<span class="count">(${t.completed.count})</span></button>
        <button class="tab-btn ${activeTab==='inProgress'?'active':''}" data-tab="inProgress">対応中タスク<span class="count">(${t.inProgress.count})</span></button>
        <button class="tab-btn ${activeTab==='notStarted'?'active':''}" data-tab="notStarted">未対応タスク<span class="count">(${t.notStarted.count})</span></button>
      </nav>
      <div class="panel ${activeTab==='completed'?'active':''}" id="panel-completed">${renderTable(t.completed)}</div>
      <div class="panel ${activeTab==='inProgress'?'active':''}" id="panel-inProgress">${renderTable(t.inProgress)}</div>
      <div class="panel ${activeTab==='notStarted'?'active':''}" id="panel-notStarted">${renderTable(t.notStarted)}</div>

      <p class="status-note">
        「この期間で取得」を押すと、指定した期間でBacklogから完了・対応中・未対応のタスクを取得します(認証情報の入力は不要です。未取得時はサンプルを表示します)。
        期間は更新日(≒その状態になった日に近い)を基準に、3つのステータスすべてに適用されます。残工数からは「完了」と「対応中」の工数だけを差し引き、「未対応」はまだ着手前のため差し引きません。
      </p>

      <div class="section-title" style="margin-top:28px;"><h2>月次履歴</h2></div>
      ${renderHistoryTable(client)}
    `;

    section.querySelectorAll('.tab-btn').forEach(btn => {
      btn.addEventListener('click', () => { activeTab = btn.dataset.tab; renderDetail(); });
    });
    document.getElementById('btnEditClient').addEventListener('click', () => openClientModal(client));
    document.getElementById('btnFetch').addEventListener('click', async () => {
      const from = document.getElementById('detailFrom').value.trim();
      const to = document.getElementById('detailTo').value.trim();
      client.from = from || client.from;
      client.to = to || client.to;

      const statusEl = document.getElementById('fetchStatus');
      const btn = document.getElementById('btnFetch');

      btn.disabled = true;
      statusEl.style.color = 'var(--ink-soft)';
      statusEl.textContent = 'Backlogからタスクを取得中...';

      try{
        const data = await fetchFromBacklog(client, client.from, client.to);
        client.data = data;
        client.synced = true;
        saveToHistory(client, client.from, client.to, data);
        saveClientsToServer();
        renderClientGrid();
        renderDetail();
        document.getElementById('fetchStatus').textContent = '実データを取得し、月次履歴に記録しました';
        document.getElementById('fetchStatus').style.color = 'var(--accent)';
      }catch(err){
        statusEl.textContent = '取得に失敗しました: ' + err.message;
        statusEl.style.color = 'var(--red)';
        btn.disabled = false;
      }
    });

    section.querySelectorAll('[data-load-history]').forEach(btn => {
      btn.addEventListener('click', () => {
        const entry = client.history.find(h => h.from === btn.dataset.loadHistory);
        if(!entry) return;
        client.data = entry.data;
        client.from = entry.from;
        client.to = entry.to;
        renderClientGrid();
        renderDetail();
      });
    });
  }

  // ---------------- 月次履歴 ----------------
  function saveToHistory(client, from, to, data){
    const t1 = summarizeIssues(data.completed);
    const t2 = summarizeIssues(data.inProgress);
    const est = Math.round((t1.totalEst + t2.totalEst) * 100) / 100;
    const act = Math.round((t1.totalAct + t2.totalAct) * 100) / 100;
    const capacity = Math.round((client.monthlyHours + client.carryOverHours + client.extraHours) * 100) / 100;
    const remaining = Math.round((capacity - est - act) * 100) / 100;
    const entry = { from, to, fetchedAt: new Date().toISOString(), est, act, capacity, remaining, data };

    const idx = client.history.findIndex(h => h.from === from && h.to === to);
    if(idx >= 0) client.history[idx] = entry; else client.history.push(entry);
    client.history.sort((a, b) => (a.from < b.from ? 1 : -1)); // 新しい期間が上に来るように
  }

  function renderHistoryTable(client){
    if(!client.history || client.history.length === 0){
      return '<div class="empty">まだ履歴がありません。「この期間で取得」を押すと、その期間の集計結果がここに記録されます。</div>';
    }
    const rows = client.history.map(h => `
      <tr>
        <td data-label="期間">${escapeHtml(h.from)} 〜 ${escapeHtml(h.to)}</td>
        <td data-label="想定工数" class="num">${h.est}</td>
        <td data-label="確定工数" class="num">${h.act}</td>
        <td data-label="残工数" class="num">${h.remaining}</td>
        <td data-label="操作"><button class="ghost" style="font-size:11px; padding:3px 9px;" data-load-history="${escapeHtml(h.from)}">この期間を表示</button></td>
      </tr>
    `).join('');
    return `
      <table>
        <thead><tr><th>期間</th><th class="num">想定工数</th><th class="num">確定工数</th><th class="num">残工数</th><th>操作</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    `;
  }

  function renderTable(t){
    if(!t || t.issues.length === 0){
      return '<div class="empty">該当する課題はありません。</div>';
    }
    const rows = t.issues.map(i => `
      <tr>
        <td data-label="課題キー"><span class="issue-key">${escapeHtml(i.issueKey)}</span></td>
        <td data-label="概要">${escapeHtml(i.summary)}</td>
        <td data-label="種別">${escapeHtml(i.type)}</td>
        <td data-label="状態"><span class="badge-status ${statusClass(i.status)}">${escapeHtml(i.status)}</span></td>
        <td data-label="想定工数" class="num">${i.est}</td>
        <td data-label="確定工数" class="num">${i.act}</td>
      </tr>
    `).join('');
    return `
      <table>
        <thead><tr><th>課題キー</th><th>概要</th><th>種別</th><th>状態</th><th class="num">想定工数</th><th class="num">確定工数</th></tr></thead>
        <tbody>${rows}</tbody>
        <tfoot><tr><td colspan="4">合計</td><td class="num">${t.totalEst}</td><td class="num">${t.totalAct}</td></tr></tfoot>
      </table>
    `;
  }

  // ---------------- クライアント追加モーダル ----------------
  document.getElementById('clientSearch').addEventListener('input', (e) => {
    filterText = e.target.value;
    renderClientGrid();
  });
  document.getElementById('directorFilter').addEventListener('change', (e) => {
    filterDirector = e.target.value;
    renderClientGrid();
  });

  const overlay = document.getElementById('addClientOverlay');
  let editingClientId = null;

  function openClientModal(client){
    editingClientId = client ? client.id : null;
    document.getElementById('clientModalTitle').textContent = client ? 'クライアントを編集' : 'クライアントを追加';
    document.getElementById('btnSaveClient').textContent = client ? '更新する' : '登録する';
    document.getElementById('btnDeleteClient').style.display = client ? 'inline-block' : 'none';

    document.getElementById('inputName').value = client ? client.name : '';
    document.getElementById('inputDirector').value = client ? (client.director || '') : '';
    document.getElementById('inputSpaceUrl').value = backlogSettings?.spaceUrl || '';
    document.getElementById('connectionNote').textContent = '取得可能なプロジェクト: ' + (backlogSettings?.projects.join(', ') || '未設定');
    document.getElementById('inputProjectId').value = client ? client.projectId : '';
    document.getElementById('inputMonthly').value = client ? client.monthlyHours : '';
    document.getElementById('inputCarry').value = client ? client.carryOverHours : '';
    document.getElementById('inputExtra').value = client ? client.extraHours : '';

    overlay.classList.add('active');
  }

  document.getElementById('btnAddClient').addEventListener('click', () => openClientModal(null));
  document.getElementById('btnCancelAdd').addEventListener('click', () => overlay.classList.remove('active'));
  overlay.addEventListener('click', (e) => { if(e.target === overlay) overlay.classList.remove('active'); });

  document.getElementById('btnSaveClient').addEventListener('click', () => {
    const name = document.getElementById('inputName').value.trim();
    const director = document.getElementById('inputDirector').value.trim();
    const spaceUrl = document.getElementById('inputSpaceUrl').value.trim();
    const projectId = document.getElementById('inputProjectId').value.trim();
    if(!name || !spaceUrl || !projectId){
      alert('クライアント名・スペースURL・プロジェクトIDは必須です');
      return;
    }
    if(!backlogSettings || spaceUrl !== backlogSettings.spaceUrl || !backlogSettings.projects.includes(projectId)){
      alert('管理者が登録したプロジェクトIDまたはキーを入力してください');
      return;
    }
    const monthlyHours = parseFloat(document.getElementById('inputMonthly').value) || 0;
    const carryOverHours = parseFloat(document.getElementById('inputCarry').value) || 0;
    const extraHours = parseFloat(document.getElementById('inputExtra').value) || 0;

    if(editingClientId){
      const c = clients.find(cl => cl.id === editingClientId);
      const credentialsChanged = c.spaceUrl !== spaceUrl || c.projectId !== projectId;
      Object.assign(c, { name, director, spaceUrl, projectId, monthlyHours, carryOverHours, extraHours });
      if(credentialsChanged){
        // 接続先が変わった場合は取得済みデータを無効化し、再取得を促す
        c.data = null;
        c.synced = false;
      }
      saveClientsToServer();
      overlay.classList.remove('active');
      renderClientGrid();
      if(selectedClientId === c.id) renderDetail();
    } else {
      const id = 'c' + Date.now();
      clients.push({
        id, name, director, spaceUrl, projectId,
        monthlyHours, carryOverHours, extraHours,
        from: '2026-08-01', to: '2026-08-30', synced: false, data: null, history: [],
      });
      saveClientsToServer();
      overlay.classList.remove('active');
      renderClientGrid();
      openDetail(id);
    }
  });

  document.getElementById('btnDeleteClient').addEventListener('click', () => {
    if(!editingClientId) return;
    if(!confirm('このクライアントを削除しますか？')) return;
    clients = clients.filter(c => c.id !== editingClientId);
    saveClientsToServer();
    if(selectedClientId === editingClientId){
      overlay.classList.remove('active');
      backToList();
      return;
    }
    overlay.classList.remove('active');
    renderClientGrid();
  });

  // ---------------- 初期描画 ----------------
  (async () => {
    showSyncBanner('クライアント一覧を読み込み中...', false);
    await loadClientsFromServer();
    const banner = document.getElementById('syncBanner');
    if(banner?.textContent === 'クライアント一覧を読み込み中...') banner.remove();
    if(!CLIENTS_API_URL){
      showSyncBanner('共有ストレージが未設定です。この画面を閉じると登録内容は失われます(設定方法は管理者に確認してください)。', false);
    }
    try{
      backlogSettings = await requestApi('/api/config');
      document.getElementById('btnAddClient').disabled = false;
    }catch(err){
      showSyncBanner(err.message, true);
    }
    renderClientGrid();
  })();
