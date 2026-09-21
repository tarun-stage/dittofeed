import { resolveStageWarehouseMobilePushEligibility } from "./users";

describe("resolveStageWarehouseMobilePushEligibility", () => {
  it("uses current raw user flags ahead of stale profile flags", () => {
    expect(
      resolveStageWarehouseMobilePushEligibility({
        notificationStatus: "active",
        uninstalledStatus: "false",
        fallbackNotificationsActive: false,
        fallbackHasUninstalled: true,
        deviceToken: "firebase-token",
      }),
    ).toEqual({
      notificationsActive: true,
      hasUninstalled: false,
      mobilePushEligible: true,
    });
  });

  it.each(["inactive", false])(
    "blocks delivery for notificationStatus=%p",
    (notificationStatus) => {
      expect(
        resolveStageWarehouseMobilePushEligibility({
          notificationStatus,
          uninstalledStatus: false,
          fallbackNotificationsActive: true,
          fallbackHasUninstalled: false,
          deviceToken: "firebase-token",
        }).mobilePushEligible,
      ).toBe(false);
    },
  );

  it.each(["true", true, "uninstalled"])(
    "ignores has_uninstalled=%p for push eligibility",
    (uninstalledStatus) => {
      expect(
        resolveStageWarehouseMobilePushEligibility({
          notificationStatus: "active",
          uninstalledStatus,
          fallbackNotificationsActive: false,
          fallbackHasUninstalled: true,
          deviceToken: "firebase-token",
        }).mobilePushEligible,
      ).toBe(true);
    },
  );

  it("falls back to profile flags when raw flags are unavailable", () => {
    expect(
      resolveStageWarehouseMobilePushEligibility({
        notificationStatus: "",
        uninstalledStatus: null,
        fallbackNotificationsActive: "1",
        fallbackHasUninstalled: "0",
        deviceToken: "firebase-token",
      }),
    ).toEqual({
      notificationsActive: true,
      hasUninstalled: false,
      mobilePushEligible: true,
    });
  });

  it("requires a non-empty device token", () => {
    expect(
      resolveStageWarehouseMobilePushEligibility({
        notificationStatus: true,
        uninstalledStatus: false,
        fallbackNotificationsActive: false,
        fallbackHasUninstalled: true,
        deviceToken: "   ",
      }).mobilePushEligible,
    ).toBe(false);
  });
});
