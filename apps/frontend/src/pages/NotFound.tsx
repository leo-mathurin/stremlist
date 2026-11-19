import { Link } from "react-router";
import Header from "../components/Header";
import { useSEO } from "../hooks/useSEO";
import { Button } from "@/components/ui/button";

export default function NotFound() {
  useSEO({ path: "/404" });

  return (
    <div className="max-w-3xl mx-auto my-8 bg-white rounded-lg shadow-md p-8">
      <Header />

      <main className="py-12 text-center">
        <h2 className="text-2xl font-bold text-ink">Page not found</h2>
        <p className="mx-auto mt-3 max-w-md text-black/60">
          This address does not match a Stremlist page.
        </p>
        <Button asChild className="mt-6">
          <Link to="/">Return to home</Link>
        </Button>
      </main>
    </div>
  );
}
