import { Navigate, Route, Routes } from "react-router-dom";
import { Layout } from "./components/Layout";
import { Spinner } from "./components/ui";
import { useAuth } from "./lib/auth";
import { BatchDetail } from "./pages/BatchDetail";
import { Home } from "./pages/Home";
import { Login } from "./pages/Login";
import { Certificates, Ops } from "./pages/Ops";
import { CandidateDownload, Verify } from "./pages/Public";

function Protected({ children, roles }: { children: React.ReactNode; roles?: string[] }) {
  const { me, loading } = useAuth();
  if (loading) return <Spinner />;
  if (!me) return <Navigate to="/login" replace />;
  if (roles && !roles.includes(me.role)) return <Navigate to="/" replace />;
  return <>{children}</>;
}

export default function App() {
  return (
    <Routes>
      {/* public: no login ever required */}
      <Route path="/verify" element={<Verify />} />
      <Route path="/verify/:number" element={<Verify />} />
      <Route path="/c/:token" element={<CandidateDownload />} />
      <Route path="/login" element={<Login />} />
      <Route element={<Protected><Layout /></Protected>}>
        <Route path="/" element={<Home />} />
        <Route path="/batches/:id" element={<BatchDetail />} />
        <Route path="/ops" element={<Protected roles={["state", "quality"]}><Ops /></Protected>} />
        <Route path="/certificates" element={<Certificates />} />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
