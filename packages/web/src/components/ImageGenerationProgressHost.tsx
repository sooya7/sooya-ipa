import { useEffect, useMemo, useState } from 'react';
import { currentSooyaClient } from '../lib/sooyaClient.js';
import './ImageGenerationProgressHost.css';

interface ActiveImageGeneration {
  key: string;
  startedAt: number;
}

function eventKey(data: Record<string, unknown>): string {
  const batchId = typeof data.batchId === 'string' ? data.batchId : '';
  const revision = Number(data.revision ?? 0);
  if (batchId && Number.isFinite(revision) && revision > 0) return `${batchId}:${revision}`;
  return typeof data.messageId === 'string' ? data.messageId : '';
}

function isSameGeneration(active: ActiveImageGeneration, data: Record<string, unknown>): boolean {
  const key = eventKey(data);
  return !key || key === active.key;
}

export function ImageGenerationProgressHost() {
  const [active, setActive] = useState<ActiveImageGeneration | null>(null);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const client = currentSooyaClient();
    if (!client) return;
    return client.subscribe((event) => {
      if (event.type === 'reply.image.generating') {
        const key = eventKey(event.data);
        setActive((current) => current?.key === key ? current : { key, startedAt: Date.now() });
        return;
      }
      if (event.type === 'reply.media.created' || event.type === 'reply.media.failed') {
        if (String(event.data.type ?? '') !== 'image') return;
        setActive((current) => current && isSameGeneration(current, event.data) ? null : current);
        return;
      }
      if (event.type === 'reply.completed' || event.type === 'reply.failed' || event.type === 'reply.interrupted') {
        setActive((current) => current && isSameGeneration(current, event.data) ? null : current);
      }
    });
  }, []);

  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [active]);

  const elapsedSeconds = useMemo(() => active ? Math.max(0, Math.floor((now - active.startedAt) / 1000)) : 0, [active, now]);
  if (!active) return null;

  return (
    <div className="image-generation-progress-host" role="status" aria-label="正在生成图片" data-testid="image-generation-progress">
      <div className="image-generation-progress-copy">
        <strong>正在生成图片</strong>
        <span aria-hidden="true">已等待 {elapsedSeconds} 秒</span>
      </div>
      <div className="image-generation-progress-track" role="progressbar" aria-label="图片生成进度">
        <span />
      </div>
    </div>
  );
}
