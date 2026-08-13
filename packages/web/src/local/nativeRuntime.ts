import { Capacitor } from '@capacitor/core';

export function isNativeSooya(): boolean { return Capacitor.isNativePlatform(); }

export function shouldRegisterPwaServiceWorker(isProduction: boolean, supported: boolean): boolean {
  return isProduction && supported && !isNativeSooya();
}

