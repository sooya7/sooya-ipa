import type { LocalCore } from '@sooya/core/app';

/**
 * Capability probe only. SOOYA does not schedule business notifications or
 * request permission on first launch; the user must explicitly enable the
 * local channel from settings. Remote push remains disabled without an app
 * entitlement and a server-side opt-in.
 */
export async function probeNotificationCapabilities(core: LocalCore): Promise<void> {
  const current = await core.configRepo.notificationCapabilities();
  try {
    const [{ LocalNotifications }, { PushNotifications }] = await Promise.all([
      import('@capacitor/local-notifications'),
      import('@capacitor/push-notifications')
    ]);
    const localPermission = await LocalNotifications.checkPermissions();
    const remotePermission = await PushNotifications.checkPermissions();
    await core.configRepo.setNotificationCapabilities({
      localSupported: localPermission.display !== 'denied',
      localEnabled: current.localEnabled,
      remoteSupported: false,
      remoteEnabled: false,
      checkedAt: new Date().toISOString(),
      detail: { localPermission: localPermission.display, remotePermission: remotePermission.receive }
    });
  } catch (error) {
    await core.configRepo.setNotificationCapabilities({
      localSupported: false,
      localEnabled: false,
      remoteSupported: false,
      remoteEnabled: false,
      checkedAt: new Date().toISOString(),
      detail: { error: error instanceof Error ? error.message : String(error) }
    });
  }
}
