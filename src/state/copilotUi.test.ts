import { beforeEach, describe, expect, it } from "vitest";
import { COPILOT_UI_STORAGE_KEY, useCopilotUi } from "./copilotUi";

beforeEach(() => {
  window.localStorage.clear();
  useCopilotUi.getState().reset();
});

describe("copilot UI store", () => {
  it("closes the drawer without clearing the active investigation", () => {
    const store = useCopilotUi.getState();

    store.openDrawer("session-1");
    store.setDraft("show latest logs from customer service");
    store.closeDrawer();

    expect(useCopilotUi.getState()).toMatchObject({
      isOpen: false,
      activeSessionId: "session-1",
      draft: "show latest logs from customer service",
    });
    expect(JSON.parse(window.localStorage.getItem(COPILOT_UI_STORAGE_KEY) ?? "{}")).toMatchObject({
      isOpen: false,
      activeSessionId: "session-1",
      draft: "show latest logs from customer service",
    });
  });

  it("starts a new investigation by clearing session and draft explicitly", () => {
    const store = useCopilotUi.getState();

    store.openDrawer("session-1");
    store.setDraft("old prompt");
    store.startNewInvestigation();

    expect(useCopilotUi.getState()).toMatchObject({
      isOpen: true,
      activeSessionId: null,
      draft: "",
    });
  });

  it("hydrates persisted drawer state defensively", () => {
    window.localStorage.setItem(
      COPILOT_UI_STORAGE_KEY,
      JSON.stringify({
        isOpen: true,
        activeSessionId: "session-2",
        draft: "summarize checkout errors",
        ignored: "value",
      }),
    );

    useCopilotUi.getState().hydrate();

    expect(useCopilotUi.getState()).toMatchObject({
      isOpen: true,
      activeSessionId: "session-2",
      draft: "summarize checkout errors",
    });
  });
});
