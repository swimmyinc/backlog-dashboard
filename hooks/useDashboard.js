'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { requestApi } from '../lib/api.js';
import { currentMonth, monthRange } from '../lib/format.js';

export default function useDashboard() {
  const [clients, setClients] = useState([]);
  const [settings, setSettings] = useState(null);
  const [selectedClientId, setSelectedClientId] = useState(null);
  // 静的HTMLと初回描画を揃え、日本時間の当月はブラウザ起動後に設定する。
  const [selectedMonth, setSelectedMonth] = useState('');
  const [filterText, setFilterText] = useState('');
  const [filterDirector, setFilterDirector] = useState('');
  const [periodMode, setPeriodMode] = useState('month');
  const [customRange, setCustomRange] = useState({ from: '', to: '' });
  const [customResult, setCustomResult] = useState(null);
  const [snapshot, setSnapshot] = useState(null);
  const [modal, setModal] = useState(null);
  const [pending, setPending] = useState(false);
  const [historyPending, setHistoryPending] = useState(false);
  const [notice, setNotice] = useState({ message: '共有データを読み込み中…', error: false });
  const [operationStatus, setOperationStatus] = useState('');
  const busy = useRef(false);
  const generation = useRef(0);
  const historyGeneration = useRef(0);
  const alive = useRef(true);
  const initialized = useRef(false);
  const isAdmin = settings?.user.isAdmin === true;
  const selectedClient = clients.find(client => client.id === selectedClientId) || null;
  const showNotice = (message, error = false) => setNotice({ message, error });
  const replaceClient = updated => setClients(list => list.some(client => client.id === updated.id)
    ? list.map(client => client.id === updated.id ? updated : client) : [...list, updated]);

  function clearViewResults() {
    generation.current++;
    historyGeneration.current++;
    setCustomResult(null);
    setSnapshot(null);
    setHistoryPending(false);
    setOperationStatus('');
  }
  function begin() {
    // Reactの再描画より先にロックし、連打でも同一更新番号を送らない。
    if (busy.current) return false;
    busy.current = true;
    setPending(true);
    return true;
  }
  function finish() {
    busy.current = false;
    if (alive.current) setPending(false);
  }
  function openDetail(id) {
    clearViewResults();
    setSelectedClientId(id);
    setPeriodMode('month');
    window.scrollTo({ top: 0, behavior: 'instant' });
  }
  function backToList() {
    clearViewResults();
    setSelectedClientId(null);
    setPeriodMode('month');
    window.scrollTo({ top: 0, behavior: 'instant' });
  }
  function changeMonth(value) {
    if (!/^[1-9]\d{3}-(0[1-9]|1[0-2])$/.test(value)) return;
    clearViewResults();
    setSelectedMonth(value);
    setPeriodMode('month');
  }
  function changeMode(mode) {
    if (mode === periodMode) return;
    clearViewResults();
    setPeriodMode(mode);
    if (mode === 'custom') setCustomRange(monthRange(selectedMonth));
  }
  function changeRange(field, value) {
    clearViewResults();
    setCustomRange(range => ({ ...range, [field]: value }));
  }
  const refresh = useCallback(async () => {
    if (!begin()) return;
    try {
      const config = await requestApi('/api/config');
      const result = await requestApi('/api/clients');
      if (!alive.current) return;
      setSettings(config);
      setClients(result.clients);
      setSelectedClientId(id => result.clients.some(client => client.id === id) ? id : null);
      setModal(null);
      clearViewResults();
      setNotice(null);
    } catch (error) {
      if (alive.current) showNotice(error.message, true);
    } finally { finish(); }
  }, []);
  useEffect(() => {
    alive.current = true;
    if (!initialized.current) {
      initialized.current = true;
      setSelectedMonth(currentMonth());
      void refresh();
    }
    return () => { alive.current = false; generation.current++; historyGeneration.current++; };
  }, [refresh]);

  async function mutate(client, path, method, payload, message) {
    if (!begin()) return false;
    const token = generation.current;
    setOperationStatus('処理中…');
    try {
      const updated = await requestApi('/api/clients/' + client.id + path, method, { ...payload, revision: client.revision });
      if (!alive.current) return false;
      replaceClient(updated);
      showNotice(message);
      if (generation.current === token) setOperationStatus('');
      return true;
    } catch (error) {
      if (alive.current) {
        showNotice(error.message, true);
        if (generation.current === token) setOperationStatus('操作に失敗しました。上のメッセージを確認してください。');
      }
      return false;
    } finally { finish(); }
  }
  async function fetchCustom() {
    const { from, to } = customRange;
    if (!selectedClient || !from || !to || from > to) {
      showNotice('開始日・終了日を正しく指定してください。', true);
      return;
    }
    if (!begin()) return;
    const token = ++generation.current;
    setCustomResult(null);
    setOperationStatus('Backlogから取得中…');
    try {
      const result = await requestApi('/api/clients/' + selectedClient.id + '/preview', 'POST', { from, to });
      // 移動・期間変更後の古い応答は、成功・失敗のどちらも表示へ反映しない。
      if (!alive.current || generation.current !== token) return;
      setCustomResult(result);
      setOperationStatus('');
      setNotice(null);
    } catch (error) {
      if (alive.current && generation.current === token) {
        showNotice(error.message, true);
        setOperationStatus('取得に失敗しました。条件を確認して再取得してください。');
      }
    } finally { finish(); }
  }
  async function loadHistory(client, id) {
    const token = ++historyGeneration.current;
    const viewToken = generation.current;
    setHistoryPending(true);
    try {
      const result = await requestApi('/api/clients/' + client.id + '/history/' + id);
      if (alive.current && token === historyGeneration.current && viewToken === generation.current) setSnapshot(result);
    } catch (error) {
      if (alive.current && token === historyGeneration.current && viewToken === generation.current) showNotice(error.message, true);
    } finally {
      if (alive.current && token === historyGeneration.current) setHistoryPending(false);
    }
  }
  function openModal(client = null) {
    if (isAdmin && !busy.current) setModal({ client });
  }
  function closeModal() { if (!busy.current) setModal(null); }
  async function saveClient(values, remove = false) {
    if (!isAdmin || !modal || busy.current) return;
    const original = modal.client;
    if (remove && (!original || !window.confirm('このクライアントと全月の設定・追加明細・取得結果・旧履歴を削除しますか？'))) return;
    if (!begin()) return;
    try {
      const payload = { ...(remove ? {} : values), ...(original ? { revision: original.revision } : {}) };
      const result = await requestApi('/api/clients' + (original ? '/' + original.id : ''), remove ? 'DELETE' : original ? 'PUT' : 'POST', payload);
      if (!alive.current) return;
      if (remove) {
        setClients(list => list.filter(client => client.id !== original.id));
        backToList();
      } else {
        replaceClient(result);
        openDetail(result.id);
      }
      setModal(null);
      showNotice(remove ? 'クライアントを削除しました。' : 'クライアントを保存しました。');
    } catch (error) {
      if (alive.current) throw error;
    } finally { finish(); }
  }
  return {
    clients, settings, selectedClient, selectedClientId, selectedMonth, filterText, setFilterText,
    filterDirector, setFilterDirector, periodMode, customRange, customResult, snapshot, modal,
    pending, historyPending, notice, operationStatus, isAdmin,
    dismissNotice: () => setNotice(null),
    refresh, openDetail, backToList, changeMonth, changeMode, changeRange,
    mutate, fetchCustom, loadHistory, openModal, closeModal, saveClient,
  };
}
