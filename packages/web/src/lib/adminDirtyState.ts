export const ADMIN_SAVED_EVENT = 'sooya:admin-saved';

export type AdminSavedDetail = { scope: string };

/** Clear only the form section that actually finished saving. */
export function notifyAdminSaved(scope: string): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent<AdminSavedDetail>(ADMIN_SAVED_EVENT, { detail: { scope } }));
}
