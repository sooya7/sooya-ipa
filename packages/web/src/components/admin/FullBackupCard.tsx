import { useState } from 'react';
import { exportFullBackup, fullBackupAvailable, importFullBackup, pickFullBackup, type PickedFullBackup } from '../../local/fullBackup.js';

function readableBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '未知大小';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function FullBackupCard({ onNotice }: { onNotice: (message: string) => void }) {
  const [includeSecrets, setIncludeSecrets] = useState(false);
  const [exportPassword, setExportPassword] = useState('');
  const [importPassword, setImportPassword] = useState('');
  const [selected, setSelected] = useState<PickedFullBackup | null>(null);
  const [busy, setBusy] = useState<'export' | 'pick' | 'import' | null>(null);

  if (!fullBackupAvailable()) return null;

  const doExport = async () => {
    setBusy('export');
    try {
      const result = await exportFullBackup({ includeSecrets, password: exportPassword });
      onNotice(`完整备份已导出：${result.name}（${readableBytes(result.bytes)}）`);
    } catch (error) {
      onNotice(error instanceof Error ? error.message : '完整备份导出失败');
    } finally {
      setBusy(null);
    }
  };

  const chooseImport = async () => {
    setBusy('pick');
    try {
      const picked = await pickFullBackup();
      if (picked) {
        setSelected(picked);
        setImportPassword('');
      }
    } catch (error) {
      onNotice(error instanceof Error ? error.message : '备份文件选择失败');
    } finally {
      setBusy(null);
    }
  };

  const doImport = async () => {
    if (!selected) return;
    const confirmed = window.confirm(`确认从“${selected.displayName}”恢复全部内容？\n\n当前数据库与媒体会先保留回滚副本，成功后 App 将重新载入。`);
    if (!confirmed) return;
    setBusy('import');
    try {
      const result = await importFullBackup(selected, importPassword);
      onNotice(`完整备份已恢复（schema ${result.schemaVersion}），正在重新载入…`);
      setSelected(null);
      window.setTimeout(() => window.location.reload(), 250);
    } catch (error) {
      onNotice(error instanceof Error ? error.message : '完整备份导入失败，已尝试回滚');
    } finally {
      setBusy(null);
    }
  };

  return (
    <article className="admin-card" data-testid="admin-full-backup">
      <div className="admin-card-heading">
        <div>
          <span className="admin-card-kicker">FULL BACKUP</span>
          <h2>完整导入 / 导出</h2>
          <p>一份文件带走聊天、记忆、人设、Life、模型/MCP 配置、头像、参考图、表情和所有用户媒体。OTA 缓存与系统临时文件不会打包。</p>
        </div>
        <span className="admin-status-chip is-ready">Native Base 11</span>
      </div>

      <div style={{ display: 'grid', gap: 10, marginTop: 14 }}>
        <label style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <input type="checkbox" checked={includeSecrets} onChange={(event) => setIncludeSecrets(event.target.checked)} />
          <span>同时导出 API Key / MCP Token（密码加密）</span>
        </label>
        {includeSecrets && (
          <label style={{ display: 'grid', gap: 6 }}>
            <span>备份密码</span>
            <input
              type="password"
              value={exportPassword}
              onChange={(event) => setExportPassword(event.target.value)}
              autoComplete="new-password"
              placeholder="至少 10 个字符"
            />
          </label>
        )}
        <p className="admin-muted" style={{ margin: 0 }}>
          默认不会把 Keychain 密钥写进备份文件。勾选后密钥只会以 AES-GCM 加密块进入备份，恢复时需要同一个密码。
        </p>
        <div className="admin-actions">
          <button type="button" onClick={() => void doExport()} disabled={busy !== null}>
            {busy === 'export' ? '正在打包…' : '导出全部内容'}
          </button>
          <button type="button" onClick={() => void chooseImport()} disabled={busy !== null}>
            {busy === 'pick' ? '正在打开文件…' : '选择备份文件'}
          </button>
        </div>
      </div>

      {selected && (
        <div style={{ display: 'grid', gap: 10, marginTop: 16, paddingTop: 14, borderTop: '1px solid var(--border)' }}>
          <div>
            <strong className="admin-breakable">{selected.displayName}</strong>
            <small style={{ display: 'block' }}>{readableBytes(selected.bytes)}</small>
          </div>
          <label style={{ display: 'grid', gap: 6 }}>
            <span>备份密码（如果导出时包含密钥）</span>
            <input
              type="password"
              value={importPassword}
              onChange={(event) => setImportPassword(event.target.value)}
              autoComplete="current-password"
              placeholder="未包含密钥可留空"
            />
          </label>
          <div className="admin-actions">
            <button type="button" onClick={() => void doImport()} disabled={busy !== null}>
              {busy === 'import' ? '正在校验并恢复…' : '导入并恢复全部内容'}
            </button>
            <button type="button" onClick={() => setSelected(null)} disabled={busy !== null}>取消</button>
          </div>
        </div>
      )}
    </article>
  );
}
