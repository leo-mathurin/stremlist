import { BrowserRouter, Routes, Route } from "react-router";
import Home from "./pages/Home";
import Terms from "./pages/Terms";
import Changelog from "./pages/Changelog";
import Configure from "./pages/Configure";

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<Home />} />
        <Route path="/terms" element={<Terms />} />
        <Route path="/changelog" element={<Changelog />} />
        <Route path="/configure" element={<Configure />} />
      </Routes>
    </BrowserRouter>
  );
}
