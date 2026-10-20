  let clients = [];
  let backlogSettings = null;
  let selectedSnapshot = null;

  async function loadClientsFromServer(){
    clients = (await requestApi('/api/clients')).clients;
  }
  function replaceClient(client){
    const index = clients.findIndex(c => c.id === client.id);
    if(index < 0) clients.push(client); else clients[index] = client;
  }
  function isAdmin(){ return backlogSettings?.user.isAdmin === true; }

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

  function getIssuesForClient(client){
    return client.data || { completed: [], inProgress: [], notStarted: [] };
  }

  // APIの認証情報はWorkerだけが扱う。
  async function requestApi(path, method = 'GET', data){
    const res = await fetch(path, { credentials: 'same-origin', method, ...(data ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) } : {}) });
    let body;
    try{
      body = await res.json();
    }catch{
      throw new Error('接続を確認できません。画面を再読み込みしてください。');
    }
    if(!res.ok) throw new Error(body.error || '取得に失敗しました。');
    return body;
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
      empty.textContent = (isAdmin() ? 'クライアントがまだ登録されていません。「＋ クライアント追加」から登録してください。' : '登録済みのプロジェクトがありません。管理者に登録を依頼してください。');
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
            ${isAdmin() ? `<button class="ghost" data-edit="${escapeHtml(c.id)}">編集</button>` : ''}
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
    selectedSnapshot = null;
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
    const displayClient = selectedSnapshot ? { ...client, ...selectedSnapshot, monthlyHours: selectedSnapshot.capacity, carryOverHours: 0, extraHours: 0 } : client;
    const t = getClientTotals(displayClient);
    const cls = balClass(t.remaining, t.capacity || 1);

    section.innerHTML = `
      <div class="detail-head">
        <div>
          <h2>${escapeHtml(client.name)} ${isAdmin() ? '<button class="ghost" id="btnEditClient">編集</button>' : ''}</h2>
          <div class="meta">${escapeHtml(client.spaceUrl)} ・ Project #${escapeHtml(client.projectId)} ・ 担当: ${escapeHtml(client.director || '未設定')}</div>
        </div>
        <div class="period-fields">
          <span>集計期間</span>
          <input type="text" id="detailFrom" value="${escapeHtml(displayClient.from)}">
          <span>〜</span>
          <input type="text" id="detailTo" value="${escapeHtml(displayClient.to)}">
          <button class="primary" id="btnFetch">この期間で取得</button>
        </div>
      </div>

      <div id="fetchStatus" role="status" style="font-size:12px; margin-bottom:14px;">${selectedSnapshot ? '履歴を表示中（取得時の契約工数で集計）' : client.synced ? '保存済みの取得結果を表示中' : '未取得です。期間を指定して取得してください。'}</div>${selectedSnapshot ? '<button class="ghost" id="btnLatest">最新の保存結果に戻る</button>' : ''}

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
        「この期間で取得」を押すと、指定した期間でBacklogから完了・対応中・未対応のタスクを取得します(認証情報の入力は不要です。取得結果は利用者全員で共有されます)。
        期間は更新日(≒その状態になった日に近い)を基準に、3つのステータスすべてに適用されます。残工数からは「完了」と「対応中」の工数だけを差し引き、「未対応」はまだ着手前のため差し引きません。
      </p>

      <div class="section-title" style="margin-top:28px;"><h2>月次履歴</h2></div>
      ${renderHistoryTable(client)}
    `;

    section.querySelectorAll('.tab-btn').forEach(btn => {
      btn.addEventListener('click', () => { activeTab = btn.dataset.tab; renderDetail(); });
    });
    document.getElementById('btnEditClient')?.addEventListener('click', () => openClientModal(client));
    document.getElementById('btnFetch').addEventListener('click', async () => {
      const from = document.getElementById('detailFrom').value.trim();
      const to = document.getElementById('detailTo').value.trim();


      const statusEl = document.getElementById('fetchStatus');
      const btn = document.getElementById('btnFetch');

      btn.disabled = true;
      statusEl.style.color = 'var(--ink-soft)';
      statusEl.textContent = 'Backlogからタスクを取得中...';

      try{
        const updated = await requestApi('/api/clients/' + client.id + '/fetch', 'POST', { from, to, revision: client.revision });
        replaceClient(updated);
        renderClientGrid();
        if(selectedClientId !== client.id) return;
        selectedSnapshot = null;
        renderDetail();
        document.getElementById('fetchStatus').textContent = '実データを取得し、月次履歴に記録しました';
        document.getElementById('fetchStatus').style.color = 'var(--accent)';
      }catch(err){
        statusEl.textContent = '取得に失敗しました: ' + err.message;
        statusEl.style.color = 'var(--red)';
        btn.disabled = false;
      }
    });

    document.getElementById('btnLatest')?.addEventListener('click', () => { selectedSnapshot = null; renderDetail(); });
    section.querySelectorAll('[data-load-history]').forEach(btn => {
      btn.addEventListener('click', async () => {
        btn.disabled = true;
        try {
          const snapshot = await requestApi('/api/clients/' + client.id + '/history/' + btn.dataset.loadHistory);
          if(selectedClientId !== client.id) return;
          selectedSnapshot = snapshot;
          renderDetail();
        } catch(err) { showSyncBanner(err.message, true); }
        finally { btn.disabled = false; }
      });
    });
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
        <td data-label="操作"><button class="ghost" style="font-size:11px; padding:3px 9px;" data-load-history="${escapeHtml(h.id)}">この期間を表示</button></td>
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
  let editingRevision = null;

  function openClientModal(client){
    if(!isAdmin() || document.getElementById('btnSaveClient').disabled) return;
    editingRevision = client?.revision;
    editingClientId = client ? client.id : null;
    document.getElementById('clientModalTitle').textContent = client ? 'クライアントを編集' : 'クライアントを追加';
    document.getElementById('btnSaveClient').textContent = client ? '更新する' : '登録する';
    document.getElementById('btnDeleteClient').style.display = client ? 'inline-block' : 'none';

    document.getElementById('inputName').value = client ? client.name : '';
    document.getElementById('inputDirector').value = client ? (client.director || '') : '';
    document.getElementById('inputSpaceUrl').value = backlogSettings?.spaceUrl || '';
    document.getElementById('connectionNote').textContent = '専用ユーザーがアクセスできるプロジェクトを登録できます。プロジェクトを変更すると取得結果と履歴は削除されます。';
    document.getElementById('inputProjectId').value = client ? client.projectId : '';
    document.getElementById('inputMonthly').value = client ? client.monthlyHours : '';
    document.getElementById('inputCarry').value = client ? client.carryOverHours : '';
    document.getElementById('inputExtra').value = client ? client.extraHours : '';

    overlay.classList.add('active');
  }

  document.getElementById('btnAddClient').addEventListener('click', () => openClientModal(null));
  document.getElementById('btnCancelAdd').addEventListener('click', () => overlay.classList.remove('active'));
  overlay.addEventListener('click', (e) => { if(e.target === overlay) overlay.classList.remove('active'); });

  async function saveRegistration(remove = false){
    const save = document.getElementById('btnSaveClient');
    const del = document.getElementById('btnDeleteClient');
    if(save.disabled) return;
    if(remove && (!editingClientId || !confirm('この登録と取得結果・履歴を全利用者の共有データから削除しますか？'))) return;
    const payload = remove ? {} : {
      name: document.getElementById('inputName').value.trim(),
      director: document.getElementById('inputDirector').value.trim(),
      projectId: document.getElementById('inputProjectId').value.trim(),
      monthlyHours: Number(document.getElementById('inputMonthly').value.trim()),
      carryOverHours: Number(document.getElementById('inputCarry').value.trim()),
      extraHours: Number(document.getElementById('inputExtra').value.trim()),
    };
    if(editingClientId) payload.revision = editingRevision;
    const targetId = editingClientId;
    save.disabled = del.disabled = true;
    try {
      const result = await requestApi('/api/clients' + (targetId ? '/' + targetId : ''), remove ? 'DELETE' : targetId ? 'PUT' : 'POST', payload);
      if(remove) clients = clients.filter(c => c.id !== targetId); else replaceClient(result);
      selectedSnapshot = null;
      overlay.classList.remove('active');
      renderClientGrid();
      if(remove) backToList(); else openDetail(result.id);
    } catch(err) { alert(err.message); }
    finally { save.disabled = del.disabled = false; }
  }
  document.getElementById('btnSaveClient').addEventListener('click', () => saveRegistration());
  document.getElementById('btnDeleteClient').addEventListener('click', () => saveRegistration(true));

  async function refresh(){
    const button = document.getElementById('btnRefresh');
    button.disabled = true;
    try {
      backlogSettings = await requestApi('/api/config');
      await loadClientsFromServer();
      document.getElementById('btnAddClient').hidden = !isAdmin();
      document.getElementById('btnAddClient').disabled = !isAdmin();
      document.getElementById('userIdentity').textContent = backlogSettings.user.email + (isAdmin() ? '（管理者）' : '（閲覧・取得）');
      overlay.classList.remove('active');
      selectedSnapshot = null;
      renderClientGrid();
      if(selectedClientId) renderDetail();
      document.getElementById('syncBanner')?.remove();
    } catch(err) { showSyncBanner(err.message, true); }
    finally { button.disabled = false; }
  }
  document.getElementById('btnRefresh').addEventListener('click', refresh);
  // 初期化時は設定と共有データを読み込み、権限が確認できるまで登録を許可しない。
  (async () => {
    showSyncBanner('共有データを読み込み中...', false);
    await refresh();
  })();
