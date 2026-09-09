// Type declarations for update-notifier v7 (ships no bundled .d.ts).
// Only the surface used by src/update-check.ts is declared.

declare module "update-notifier" {
  export interface Update {
    current: string;
    latest: string;
    type:
      | "latest"
      | "major"
      | "minor"
      | "patch"
      | "prerelease"
      | "build"
      | "tag";
    name: string;
  }

  export interface UpdateNotifierOptions {
    /** package.json content (at minimum name + version). */
    pkg: { name: string; version: string };
    /** Minimum interval between update checks in ms. */
    updateCheckInterval?: number;
    /** Registry URL (default: npm). */
    distTag?: string;
    /** Disable auto-check on construction. */
    shouldNotifyInNpmScript?: boolean;
  }

  export interface NotifyOptions {
    /**
     * Message template. Supports {currentVersion}, {latestVersion},
     * {updateCommand}, and {packageName} placeholders.
     */
    message?: string;
    /** Print even when running inside an npm script (default: false). */
    isGlobal?: boolean;
    /** Called with the update info when an update is available. */
    defer?: boolean;
  }

  export interface UpdateNotifier {
    /** Trigger the update check (non-blocking). */
    check(): void;
    /** Fetch update info (resolves with undefined if up-to-date). */
    fetchInfo(): Promise<Update | undefined>;
    /** Print the update notification to stderr if one is available. */
    notify(options?: NotifyOptions): void;
    /** Update info, if a check has already resolved. */
    update?: Update;
  }

  export default function updateNotifier(
    options: UpdateNotifierOptions,
  ): UpdateNotifier;
}
