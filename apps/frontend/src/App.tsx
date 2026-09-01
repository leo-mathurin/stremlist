import { BrowserRouter, Routes, Route } from "react-router";
import { Analytics } from "@vercel/analytics/react";
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
      <Analytics />
    </BrowserRouter>
  );
}
