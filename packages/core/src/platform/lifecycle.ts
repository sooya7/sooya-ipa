export type LifecycleState = 'active' | 'inactive' | 'background' | 'terminating';
export type LifecycleDisposer = () => void;
export type LifecycleListener = (state: LifecycleState) => void | Promise<void>;
export type ShutdownListener = () => void | Promise<void>;

export interface LifecyclePlatform {
  currentState(): LifecycleState;
  onStateChange(listener: LifecycleListener): LifecycleDisposer;
  onShutdown(listener: ShutdownListener): LifecycleDisposer;
}

export type LifecycleAdapter = LifecyclePlatform;
