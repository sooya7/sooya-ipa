// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ReferencesEditor } from './FeatureAdminPage.js';
import type { PersonaReference } from '../lib/features.js';

const featureApi = vi.hoisted(() => ({
  references: vi.fn(),
  uploadReferenceSlot: vi.fn(),
  deleteReference: vi.fn(),
  referenceData: vi.fn()
}));

vi.mock('../lib/features.js', () => ({ featureApi }));

const refs: PersonaReference[] = [
  { name: '内置：01_main_reference_front_half.png', framing: 'front', configured: true, exists: true, bytes: 0 },
  { name: '内置：02_reference_full_body_standing.png', framing: 'full-body', configured: true, exists: true, bytes: 0 },
  { name: '内置：03_reference_side_profile.png', framing: 'side', configured: true, exists: true, bytes: 0 }
];

let root: Root | null = null;
let container: HTMLDivElement | null = null;

beforeEach(() => {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  featureApi.references.mockReset();
  featureApi.uploadReferenceSlot.mockReset();
  featureApi.deleteReference.mockReset();
  featureApi.referenceData.mockReset();
  featureApi.referenceData.mockResolvedValue(new Blob(['x'], { type: 'image/png' }));
});

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  container?.remove();
  root = null;
  container = null;
});

function render() {
  return act(async () => root!.render(<ReferencesEditor onNotice={vi.fn()} />));
}

describe('ReferencesEditor', () => {
  it('shows a loading state and then the three builtin slots', async () => {
    featureApi.references.mockReturnValue(Promise.resolve({ dir: null, references: refs }));
    await render();
    expect(container!.textContent).toContain('正面/半身');
    expect(container!.textContent).toContain('全身');
    expect(container!.textContent).toContain('侧脸');
    expect(container!.textContent).not.toContain('正在读取参考图…');
  });

  it('shows an error state with a retry button instead of infinite loading', async () => {
    featureApi.references.mockReturnValue(Promise.reject(new Error('network down')));
    await render();
    expect(container!.textContent).toContain('参考图读取失败');
    const retry = container!.querySelector('button') as HTMLButtonElement;
    expect(retry).not.toBeNull();

    // Retry recovers once the backend is reachable again.
    featureApi.references.mockReturnValue(Promise.resolve({ dir: null, references: refs }));
    await act(async () => retry.click());
    expect(container!.textContent).toContain('正面/半身');
    expect(container!.textContent).not.toContain('参考图读取失败');
  });

  it('calls the slot upload endpoint with the chosen framing', async () => {
    featureApi.references.mockReturnValue(Promise.resolve({ dir: null, references: refs }));
    featureApi.uploadReferenceSlot.mockReturnValue(Promise.resolve({ reference: refs[0], replaced: [], referenceImages: ['x'] }));
    await render();
    const fileInputs = container!.querySelectorAll('input[type="file"]');
    expect(fileInputs.length).toBe(3);
    const file = new File([new Uint8Array([1])], 'me.png', { type: 'image/png' });
    await act(async () => {
      const input = fileInputs[0] as HTMLInputElement;
      Object.defineProperty(input, 'files', { value: [file] });
      input.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(featureApi.uploadReferenceSlot).toHaveBeenCalledWith('front', file);
  });
});
