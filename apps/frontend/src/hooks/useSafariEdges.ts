import { useEffect, type RefObject } from "react";

export function useSafariEdges(panelRef: RefObject<HTMLElement | null>) {
  useEffect(() => {
    const panel = panelRef.current;
    if (!panel) return;

    const root = document.documentElement;
    const properties = ["--edge-top-background", "--edge-bottom-background"];
    const previous = properties.map((name) => ({
      value: root.style.getPropertyValue(name),
      priority: root.style.getPropertyPriority(name),
    }));
    const theme = document.querySelector<HTMLMetaElement>(
      'meta[name="theme-color"]',
    );
    const previousTheme = theme?.content;
    const mobile = window.matchMedia("(max-width: 1023px)");
    const viewport = window.visualViewport;
    const topEdge = document.querySelector(".edge-top");
    const bottomEdge = document.querySelector(".edge-bottom");
    let frame = 0;

    const update = () => {
      const palette = getComputedStyle(root);
      const paper = palette.getPropertyValue("--color-paper").trim();
      const ink = palette.getPropertyValue("--color-ink").trim();
      const bounds = panel.getBoundingClientRect();
      const top = viewport?.offsetTop ?? 0;
      const bottom = top + (viewport?.height ?? window.innerHeight);
      const colorAt = (y: number) =>
        mobile.matches && y >= bounds.top && y < bounds.bottom ? ink : paper;
      const topStyle = topEdge ? getComputedStyle(topEdge) : null;
      const bottomStyle = bottomEdge ? getComputedStyle(bottomEdge) : null;
      const topInset = topStyle
        ? Math.max(0, parseFloat(topStyle.height) + parseFloat(topStyle.top))
        : 5;
      const bottomInset = bottomStyle
        ? Math.max(
            0,
            parseFloat(bottomStyle.height) + parseFloat(bottomStyle.bottom),
          )
        : 5;
      const topColor = colorAt(top + topInset);
      root.style.setProperty(properties[0], topColor);
      root.style.setProperty(properties[1], colorAt(bottom - bottomInset - 1));
      if (theme) theme.content = topColor;
    };
    const schedule = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(update);
    };

    update();
    const observer = new ResizeObserver(schedule);
    observer.observe(panel);
    window.addEventListener("scroll", schedule, { passive: true });
    window.addEventListener("resize", schedule);
    window.addEventListener("pageshow", schedule);
    mobile.addEventListener("change", schedule);
    viewport?.addEventListener("resize", schedule);
    viewport?.addEventListener("scroll", schedule);

    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      window.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", schedule);
      window.removeEventListener("pageshow", schedule);
      mobile.removeEventListener("change", schedule);
      viewport?.removeEventListener("resize", schedule);
      viewport?.removeEventListener("scroll", schedule);
      properties.forEach((name, index) => {
        const { value, priority } = previous[index];
        if (value) root.style.setProperty(name, value, priority);
        else root.style.removeProperty(name);
      });
      if (theme && previousTheme !== undefined) theme.content = previousTheme;
    };
  }, [panelRef]);
}
