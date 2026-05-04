import { describe, it, expect, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { LogsSearchBox } from "./LogsSearchBox";

describe("LogsSearchBox", () => {
  it("calls onChange with query and toggles", () => {
    const onChange = vi.fn();
    render(
      <LogsSearchBox
        query=""
        regex={false}
        caseSensitive={false}
        matchCount={0}
        currentMatch={0}
        regexError={null}
        onChange={onChange}
        onPrev={() => {}}
        onNext={() => {}}
      />,
    );
    fireEvent.change(screen.getByPlaceholderText("search…"), { target: { value: "abc" } });
    expect(onChange).toHaveBeenCalledWith({ query: "abc", regex: false, caseSensitive: false });
    fireEvent.click(screen.getByTitle("regex"));
    expect(onChange).toHaveBeenCalledWith({ query: "", regex: true, caseSensitive: false });
    fireEvent.click(screen.getByTitle("case-sensitive"));
    expect(onChange).toHaveBeenCalledWith({ query: "", regex: false, caseSensitive: true });
  });

  it("Enter triggers next, Shift+Enter triggers prev, Esc clears", () => {
    const onPrev = vi.fn();
    const onNext = vi.fn();
    const onChange = vi.fn();
    render(
      <LogsSearchBox
        query="hi"
        regex={false}
        caseSensitive={false}
        matchCount={3}
        currentMatch={0}
        regexError={null}
        onChange={onChange}
        onPrev={onPrev}
        onNext={onNext}
      />,
    );
    const input = screen.getByPlaceholderText("search…");
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onNext).toHaveBeenCalled();
    fireEvent.keyDown(input, { key: "Enter", shiftKey: true });
    expect(onPrev).toHaveBeenCalled();
    fireEvent.keyDown(input, { key: "Escape" });
    expect(onChange).toHaveBeenCalledWith({ query: "", regex: false, caseSensitive: false });
  });

  it("renders match counter and red border on regex error", () => {
    const { rerender } = render(
      <LogsSearchBox
        query="x"
        regex={false}
        caseSensitive={false}
        matchCount={5}
        currentMatch={2}
        regexError={null}
        onChange={() => {}}
        onPrev={() => {}}
        onNext={() => {}}
      />,
    );
    expect(screen.getByText("3/5")).toBeTruthy();
    rerender(
      <LogsSearchBox
        query="["
        regex={true}
        caseSensitive={false}
        matchCount={0}
        currentMatch={0}
        regexError="Invalid regex"
        onChange={() => {}}
        onPrev={() => {}}
        onNext={() => {}}
      />,
    );
    expect(screen.getByPlaceholderText("search…").className).toMatch(/border-term-red/);
  });
});
