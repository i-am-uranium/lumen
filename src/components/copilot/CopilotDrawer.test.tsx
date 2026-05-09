import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it } from "vitest";
import { AI_SESSIONS_STORAGE_KEY } from "@/lib/aiSessions";
import { useCopilotUi } from "@/state/copilotUi";
import { CopilotDrawer } from "./CopilotDrawer";

beforeEach(() => {
  window.localStorage.clear();
  useCopilotUi.getState().reset();
});

function renderDrawer(route = "/cluster/ms-aks-stage/logs?ns=checkout") {
  useCopilotUi.getState().openDrawer();
  return render(
    <MemoryRouter initialEntries={[route]}>
      <CopilotDrawer clusterContext="ms-aks-stage" />
    </MemoryRouter>,
  );
}

describe("CopilotDrawer", () => {
  it("persists a latest logs investigation and renders a navigation CTA", async () => {
    renderDrawer();

    await userEvent.type(
      screen.getByRole("textbox", { name: /ask copilot/i }),
      "show latest logs from customer service",
    );
    await userEvent.click(screen.getByRole("button", { name: /send/i }));

    const cta = await screen.findByRole("link", { name: /open logs/i });
    expect(cta).toHaveAttribute(
      "href",
      "/cluster/ms-aks-stage/logs?ns=checkout&kind=deployment&name=customer-service&grep=customer+service",
    );

    const sessions = JSON.parse(window.localStorage.getItem(AI_SESSIONS_STORAGE_KEY) ?? "[]");
    expect(sessions[0]).toMatchObject({
      title: "Open logs for customer service",
      provider: "lumen-copilot",
      model: "read-only-router",
    });
    expect(useCopilotUi.getState().activeSessionId).toBe(sessions[0].id);
  });

  it("keeps the session when closed and clears it only for a new investigation", async () => {
    renderDrawer();

    await userEvent.type(screen.getByRole("textbox", { name: /ask copilot/i }), "incident update");
    await userEvent.click(screen.getByRole("button", { name: /send/i }));
    const sessionId = useCopilotUi.getState().activeSessionId;

    await userEvent.click(screen.getByRole("button", { name: /close copilot/i }));
    expect(useCopilotUi.getState().isOpen).toBe(false);
    expect(useCopilotUi.getState().activeSessionId).toBe(sessionId);

    act(() => {
      useCopilotUi.getState().openDrawer();
    });
    await userEvent.click(screen.getByRole("button", { name: /new investigation/i }));
    expect(useCopilotUi.getState()).toMatchObject({
      isOpen: true,
      activeSessionId: null,
      draft: "",
    });
  });

  it("routes sync intent to ArgoCD instead of running a mutation", async () => {
    renderDrawer("/cluster/ms-aks-stage/argocd");

    await userEvent.type(
      screen.getByRole("textbox", { name: /ask copilot/i }),
      "I deployed the doctor dashboard, please sync",
    );
    await userEvent.click(screen.getByRole("button", { name: /send/i }));

    const drawer = screen.getByRole("complementary", { name: /operator copilot/i });
    expect(within(drawer).getByText(/I will not run sync from here/i)).toBeInTheDocument();
    expect(await screen.findByRole("link", { name: /open argocd app/i })).toHaveAttribute(
      "href",
      "/cluster/ms-aks-stage/argocd?app=argocd%2Fdoctor-dashboard",
    );
  });
});
