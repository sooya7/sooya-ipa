import { useCallback, useEffect, useMemo, useState } from 'react';
import { adminRequest } from '../../lib/admin.js';
import { currentOtaUpdater } from '../../local/otaUpdater.js';
import { FullBackupCard } from './FullBackupCard.js';

export const DEFAULT_OTA_MANIFEST_URL = 'https://sooya.icu/ota/stable.json';

interface OtaState {
  current_web_version?: string | null;
  last_good_web_version?: string | null;
  pending_web_version?: string | null;
  blocked_web_version?: string | null;
  failed_web_version?: string | null;
  last_checked_at?: string | null;
  last_downloaded_at?: string | null;
  last_applied_at?: string | null;
  last_failed_at?: string | null;
  last_error?: string | null;
}

interface OtaStatusResponse {
  manifestUrl: string;
  state: OtaState | null;
}

function dateText(value: string | null | undefined): string {
  if (!value) return '暂无';
  const time = Date.parse(value);
  return Number.isFinite(time) ? new Date(time).toLocaleString('zh-CN', { hour12: false }) : value;
}

export function versionText(value: string | null | undefined): string {
  if (!value) return '暂无';
  // New releases keep the OTA server's historical ota-<40 hex> contract, but
  // reserve 32 leading zeroes and encode the monotonic workflow run number in
  // the final 8 hex digits. Check this before the decimal compatibility form,
  // because an encoded value containing only 0-9 would otherwise match it too.
  const encodedSequence = /^ota-0{32}([0-9a-f]{8})$/iu.exec(value)?.[1];
  if (encodedSequence) return `OTA #${Number.parseInt(encodedSequence, 16)}`;
  const legacySequence = /^ota-(?:run-)?(\d+)$/iu.exec(value)?.[1];
  if (legacySequence) return `OTA #${Number(legacySequence)}`;
  return value;
}

function updateResultText(reason: string | undefined): string {
  if (reason === 'already-current') return '当前已经是最新 OTA 版本';
  if (reason === 'release-blocked') return '该 OTA 版本已被设备阻止，请先检查最近错误';
  if (reason === 'updater-unavailable') return '当前环境不支持 IPA OTA 更新';
  if (reason === 'no-pending-update') return '没有等待安装的 OTA 更新';
  if (reason === 'already-active') return '新版本已经切换，正在完成状态确认';
  return reason || '没有发现可安装的 OTA 更新';
}

export function OtaDiagnosticsCard({ onNotice }: { onNotice: (message: string) => void }) {
  const [data, setData] = useState<OtaStatusResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [updating, setUpdating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [manifestUrl, setManifestUrl] = useState(DEFAULT_OTA_MANIFEST_URL);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const result = await adminRequest<OtaStatusResponse>('/api/admin/ota');
      setData(result);
      setManifestUrl(result.manifestUrl || DEFAULT_OTA_MANIFEST_URL);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'OTA 状态读取失败');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const state = data?.state ?? {};
  const status = useMemo(() => {
    if (state.last_error) return { text: '异常', className: 'is-warn' };
    if (state.blocked_web_version) return { text: '已阻止版本', className: 'is-warn' };
    if (state.pending_web_version) return { text: '已下载，待安装', className: 'is-ready' };
    if (state.current_web_version) return { text: '已启用', className: 'is-ready' };
    return { text: '未验证', className: 'is-muted' };
  }, [state.blocked_web_version, state.current_web_version, state.last_error, state.pending_web_version]);

  const save = async () => {
    const next = manifestUrl.trim();
    if (!/^https:\/\//iu.test(next)) {
      onNotice('OTA Manifest 地址必须使用 HTTPS');
      return;
    }
    setSaving(true);
    try {
      const result = await adminRequest<OtaStatusResponse>('/api/admin/ota', { method: 'PUT', body: { manifestUrl: next } });
      setData(result);
      setManifestUrl(result.manifestUrl || next);
      setError(null);
      onNotice('OTA Manifest 地址已保存');
    } catch (cause) {
      onNotice(cause instanceof Error ? cause.message : 'OTA 地址保存失败');
    } finally {
      setSaving(false);
    }
  };

  const updateNow = async () => {
    const next = manifestUrl.trim();
    if (!/^https:\/\//iu.test(next)) {
      onNotice('OTA Manifest 地址必须使用 HTTPS');
      return;
    }
    const updater = currentOtaUpdater();
    if (!updater) {
      onNotice('当前环境没有可用的 IPA OTA 更新器');
      return;
    }
    setUpdating(true);
    try {
      const checked = await updater.checkAndDownload(next);
      if (checked.downloaded || checked.reason === 'already-pending') {
        onNotice('OTA 已下载，正在立即切换版本…');
        const applied = await updater.applyPendingNow();
        if (!applied.applied) onNotice(updateResultText(applied.reason));
      } else {
        onNotice(updateResultText(checked.reason));
      }
      await load();
    } catch (cause) {
      onNotice(cause instanceof Error ? cause.message : 'OTA 手动更新失败');
    } finally {
      setUpdating(false);
    }
  };

  return (
    <>
      <FullBackupCard onNotice={onNotice} />
      <article className="admin-card" data-testid="admin-ota-diagnostics">
        <div className="admin-card-heading">
          <div>
            <span className="admin-card-kicker">OTA DIAGNOSTICS</span>
            <h2>OTA 状态</h2>
            <p>可手动检查并立即安装 Web Bundle。安装时 App 会自动重新载入，不需要彻底退出再打开。</p>
          </div>
          <span className={`admin-status-chip ${status.className}`}>{loading ? '读取中' : status.text}</span>
        </div>

        {error && <p className="admin-inline-error" role="status">{error}</p>}

        <div style={{ display: 'grid', gap: 10, gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))', margin: '14px 0' }}>
          <div><small>当前 Web 版本</small><strong className="admin-breakable" style={{ display: 'block' }}>{versionText(state.current_web_version)}</strong></div>
          <div><small>待应用版本</small><strong className="admin-breakable" style={{ display: 'block' }}>{versionText(state.pending_web_version)}</strong></div>
          <div><small>最后良好版本</small><strong className="admin-breakable" style={{ display: 'block' }}>{versionText(state.last_good_web_version)}</strong></div>
          <div><small>已阻止版本</small><strong className="admin-breakable" style={{ display: 'block' }}>{versionText(state.blocked_web_version)}</strong></div>
          <div><small>最后检查</small><strong style={{ display: 'block' }}>{dateText(state.last_checked_at)}</strong></div>
          <div><small>最后下载</small><strong style={{ display: 'block' }}>{dateText(state.last_downloaded_at)}</strong></div>
          <div><small>最后应用</small><strong style={{ display: 'block' }}>{dateText(state.last_applied_at)}</strong></div>
          <div><small>最后失败</small><strong style={{ display: 'block' }}>{dateText(state.last_failed_at)}</strong></div>
        </div>

        <label style={{ display: 'grid', gap: 6 }}>
          <span>Stable Manifest 地址</span>
          <input
            data-testid="admin-ota-manifest-url"
            value={manifestUrl}
            onChange={(event) => setManifestUrl(event.target.value)}
            inputMode="url"
            autoCapitalize="none"
            autoCorrect="off"
            placeholder={DEFAULT_OTA_MANIFEST_URL}
          />
        </label>

        {!data?.manifestUrl && (
          <p style={{ margin: '8px 0 0' }}>
            <strong>当前没有持久化 OTA 地址。</strong> 本页面已填入生产 Stable 地址，保存后后续启动会直接使用它。
          </p>
        )}

        {state.last_error && <p className="admin-inline-error" role="status">最近错误：{state.last_error}</p>}

        <div className="admin-actions" style={{ marginTop: 12 }}>
          <button type="button" onClick={() => void updateNow()} disabled={updating || loading}>{updating ? '正在检查并安装…' : '检查并立即安装'}</button>
          <button type="button" onClick={() => void load()} disabled={loading || updating}>{loading ? '刷新中…' : '刷新状态'}</button>
          <button type="button" onClick={() => void save()} disabled={saving || updating}>{saving ? '保存中…' : data?.manifestUrl ? '保存地址' : '写入默认地址'}</button>
        </div>
      </article>
    </>
  );
}
