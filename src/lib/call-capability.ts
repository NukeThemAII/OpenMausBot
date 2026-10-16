export type CallCapabilityHelp = {
  label: string;
  reason: string;
};

const TURNS_NEED_MAC: CallCapabilityHelp = {
  label: "Calls where you take turns need the Mac app",
  reason: "They listen with on-device speech recognition, which only the Mac app has.",
};

const TURNS_ON_THIS_COMPUTER: CallCapabilityHelp = {
  label: "Calls where you take turns work on This computer",
  reason: "They listen with your Mac's own speech recognition, which only This computer can use.",
};

export function callCapabilityHelp(
  capabilities: DesktopCapabilities,
  speechServiceAvailable: boolean,
): CallCapabilityHelp | null {
  if (!capabilities.dictation.available) {
    switch (capabilities.dictation.reasonCode) {
      case "remote-server":
        return capabilities.host.platform === "darwin" ? TURNS_ON_THIS_COMPUTER : TURNS_NEED_MAC;
      case "desktop-app-required":
      case "unsupported-platform":
        return TURNS_NEED_MAC;
      default:
        return {
          label: "Calls aren't available on this device",
          reason: "This device doesn't currently provide the on-device speech recognition needed for calls.",
        };
    }
  }
  if (!speechServiceAvailable) {
    return {
      label: "The call service is unavailable",
      reason: "The speech service is unavailable in this app build. Restart or update OpenMausBot.",
    };
  }
  return null;
}
