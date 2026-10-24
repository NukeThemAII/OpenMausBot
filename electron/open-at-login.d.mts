export declare const HIDDEN_ARG: string;
export declare function autostartEntry(exec: string): string;
export declare function createOpenAtLogin(options: {
  app: {
    isPackaged: boolean;
    getLoginItemSettings(options?: { args?: string[] }): { openAtLogin: boolean; wasOpenedAtLogin?: boolean };
    setLoginItemSettings(settings: { openAtLogin: boolean; args?: string[] }): void;
  };
  file: string;
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  home: string;
  argv?: string[];
  execPath?: string;
}): { follow(on: boolean): void; startedHidden(): boolean };
