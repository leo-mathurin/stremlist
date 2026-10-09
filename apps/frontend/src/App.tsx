import { BrowserRouter, Routes, Route } from "react-router";
import { Analytics } from "@vercel/analytics/react";
import { Toaster } from "sonner";
import { CircleCheck, CircleX, Info, TriangleAlert } from "lucide-react";
import Home from "./pages/Home";
import Terms from "./pages/Terms";
import Changelog from "./pages/Changelog";
import Configure from "./pages/Configure";
import NotFound from "./pages/NotFound";

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<Home />} />
        <Route path="/terms" element={<Terms />} />
        <Route path="/changelog" element={<Changelog />} />
        <Route path="/configure" element={<Configure />} />
        <Route path="*" element={<NotFound />} />
      </Routes>
      <Toaster
        position="bottom-left"
        closeButton
        duration={6000}
        icons={{
          success: <CircleCheck className="size-4 text-emerald-600" />,
          error: <CircleX className="size-4 text-red-600" />,
          info: <Info className="size-4 text-blue-600" />,
          warning: <TriangleAlert className="size-4 text-amber-600" />,
        }}
        toastOptions={{
          style: {
            fontFamily: "var(--font-rounded)",
            borderRadius: "var(--radius-xl)",
          },
        }}
      />
      <Analytics />
    </BrowserRouter>
  );
}
