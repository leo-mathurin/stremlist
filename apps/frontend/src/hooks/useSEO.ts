import { useEffect } from "react";
import { headTags } from "../lib/seo";

export function useSEO({ path }: { path: string }) {
  useEffect(() => {
    document.head
      .querySelectorAll("[data-page-head]")
      .forEach((tag) => tag.remove());
    for (const tag of headTags(path)) {
      const element = document.createElement(tag.tag);
      element.dataset.pageHead = "";
      for (const [key, value] of Object.entries(tag.attrs))
        element.setAttribute(key, value);
      if ("content" in tag) element.textContent = tag.content;
      document.head.append(element);
    }
  }, [path]);
}
