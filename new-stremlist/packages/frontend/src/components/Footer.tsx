import { Link } from "react-router";
import NewsletterForm from "./NewsletterForm";
import { Button } from "@/components/ui/button";

export default function Footer() {
  return (
    <footer className="mt-8 pt-6 border-t border-gray-200 text-center text-sm text-gray-500 space-y-3">
      <NewsletterForm />
      <p>
        Have questions or suggestions? Contact me at{" "}
        <Button variant="link" asChild className="h-auto p-0 text-stremlist">
          <a href="mailto:lelemathrin69@gmail.com">lelemathrin69@gmail.com</a>
        </Button>
      </p>
      <p>
        This addon is not affiliated with IMDb or Stremio. It&apos;s a community
        project.
      </p>
      <p>
        <Button variant="link" asChild className="h-auto p-0 text-stremlist">
          <Link to="/terms">Terms and Privacy Policy</Link>
        </Button>
        {" | "}
        <Button variant="link" asChild className="h-auto p-0 text-stremlist">
          <Link to="/changelog">Changelog</Link>
        </Button>
      </p>
      <p>&copy; 2025 - IMDb Watchlist for Stremio</p>
      <p>
        <Button variant="link" asChild className="h-auto p-0 text-stremlist">
          <a
            href="https://ko-fi.com/lelemathrin"
            target="_blank"
            rel="noopener noreferrer"
          >
            ❤️ Like this project? Buy me a coffee
          </a>
        </Button>
      </p>
      <iframe
        src="https://status.stremlist.com/badge?theme=light"
        title="Stremlist Status"
        width={250}
        height={30}
        className="mx-auto pl-7"
        style={{ colorScheme: "normal" }}
      />
    </footer>
  );
}
