import { withBotApp } from "@/lib/bot-app-access";
import { t } from "@/lib/i18n";
import { useOwnerOrAdmin } from "@/lib/use-owner-or-admin";
import { useStore, type Bot } from "@/state/store";
import { ServiceIcon } from "../PluginsPanel";
import { Switch } from "../SettingsPrimitives";
import { SignedInSites } from "../SignedInSites";
import type { BotApp, BotApps } from "./useBotApps";
import type { useBotSettingsDerived } from "./useBotSettingsDerived";

const headCls = "mb-1 flex min-h-7 items-center justify-between gap-3";
const headTitleCls = "text-[12px] text-ink-secondary";
const headActionCls = "rounded-md px-1.5 py-0.5 text-[12px] font-medium text-accent-text hover:bg-raised";
const rowsCls = "divide-y divide-hairline/40 border-y border-hairline/40";
const rowCls = "flex items-center gap-3 py-3";
const noteCls = "mt-2 text-[12.5px] leading-relaxed text-ink-secondary";

export function VaultTab({
  bot,
  derived,
  apps,
  onOpenBrowser,
}: {
  bot: Bot;
  derived: Pick<
    ReturnType<typeof useBotSettingsDerived>,
    "patch" | "canUseConnectedApps" | "connectedAppsConfigured" | "connectedAppsEnabled" | "browserEnabled"
  >;
  apps: BotApps;
  onOpenBrowser: () => void;
}) {
  const { state, dispatch } = useStore();
  const ownerOrAdmin = useOwnerOrAdmin();
  const { patch, canUseConnectedApps, connectedAppsConfigured, connectedAppsEnabled, browserEnabled } = derived;

  const toggleApp = (app: BotApp) => {
    const connectorScopes = withBotApp(bot.connectorScopes, apps.connectedSlugs, app.slug, app.scope === null);
    if (connectorScopes) patch({ connectorScopes });
  };
  const appsNote = !canUseConnectedApps
    ? t("botSettings.simple.appsCannot", { name: bot.name })
    : apps.phase === "loading"
      ? t("common.checking")
      : apps.phase === "unknown"
        ? t("botSettings.simple.appsUnknown")
        : apps.apps.length === 0
          ? t("botSettings.simple.appsNone")
          : null;

  const profileId = bot.browserProfile ?? "";
  const profile = (state.config?.browserProfiles ?? []).find((candidate) => candidate.id === profileId);
  const temporary = profileId === "guest";
  const ownChrome = profile?.browser === "chrome" && state.config?.browserEngine?.myChrome === true;
  const sharedBy = profileId && !temporary
    ? state.bots.filter((candidate) => candidate.browserProfile === profileId).map((candidate) => candidate.name)
    : [bot.name];

  return (
    <div role="tabpanel" data-simple-vault className="mt-5 flex flex-col gap-6">
      <p className="text-[13px] leading-relaxed text-ink-secondary">{t("botSettings.simple.vaultIntro", { name: bot.name })}</p>

      <section>
        <div className={headCls}>
          <h3 className={headTitleCls}>{t("botSettings.simple.apps")}</h3>
          <button
            type="button"
            data-simple-add-app
            onClick={() => {
              dispatch({ type: "toggleSettings", open: false });
              dispatch({ type: "togglePlugins", open: true, surface: "apps" });
            }}
            className={headActionCls}
          >
            {t("botSettings.simple.addApp")}
          </button>
        </div>
        <div className={rowsCls}>
          <div className={rowCls}>
            <div className="min-w-0 flex-1 text-[13.5px] font-semibold text-ink">{t("botSettings.simple.appsAllow", { name: bot.name })}</div>
            <Switch
              checked={connectedAppsEnabled}
              aria-label={t("botSettings.simple.appsAllow", { name: bot.name })}
              disabled={!connectedAppsEnabled && (!connectedAppsConfigured || !canUseConnectedApps)}
              onClick={() => patch({ composio: !connectedAppsEnabled })}
              className="disabled:cursor-not-allowed"
            />
          </div>
          {apps.apps.map((app) => (
            <div key={app.slug} data-simple-app={app.slug} className={rowCls}>
              <ServiceIcon key={`${app.card.logo}:${app.card.domain}`} card={app.card} className="size-8 shrink-0" />
              <div className="min-w-0 flex-1">
                <div className="truncate text-[13.5px] font-medium text-ink">{app.label}</div>
                {(app.scope === "read" || app.blurb) && (
                  <div className="truncate text-[12px] text-ink-secondary">
                    {app.scope === "read" ? t("botSettings.simple.appReadOnly") : app.blurb}
                  </div>
                )}
              </div>
              <Switch
                checked={app.scope !== null}
                aria-label={t("botSettings.simple.appToggle", { name: bot.name, app: app.label })}
                disabled={!connectedAppsEnabled}
                onClick={() => toggleApp(app)}
                className="disabled:cursor-not-allowed"
              />
            </div>
          ))}
        </div>
        {appsNote && <p className={noteCls}>{appsNote}</p>}
      </section>

      <section>
        <div className={headCls}>
          <h3 className={headTitleCls}>{t("botSettings.simple.logins")}</h3>
          <button type="button" data-simple-add-login onClick={onOpenBrowser} className={headActionCls}>
            {t("botSettings.simple.addLogin")}
          </button>
        </div>
        {!browserEnabled ? (
          <p className={noteCls}>{t("botSettings.simple.loginsOff", { name: bot.name })}</p>
        ) : temporary ? (
          <p className={noteCls}>{t("settings.profiles.temporaryHint")}</p>
        ) : ownChrome ? (
          <p className={noteCls}>{t("settings.profiles.myChromeHint")}</p>
        ) : (
          <>
            {/* Security: reading and clearing a browser's sign-ins is the owner's or an admin's; the server refuses anyone else. */}
            {ownerOrAdmin !== false && (profileId === "" || profile) && (
              <SignedInSites bare key={`${bot.id}:${profileId}`} target={{ bot: bot.id }} sharedBy={sharedBy} disabled={Boolean(bot.busy)} />
            )}
            <p className={noteCls}>{t("botSettings.simple.loginsHint", { name: bot.name })}</p>
          </>
        )}
      </section>
    </div>
  );
}
