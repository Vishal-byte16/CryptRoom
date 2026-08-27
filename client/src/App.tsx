import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import NotFound from "@/pages/NotFound";
import { Route, Switch, useRoute } from "wouter";
import ErrorBoundary from "./components/ErrorBoundary";
import Home from "./pages/Home";
import Room from "./pages/Room";

function RoomRoute() {
  const [, params] = useRoute("/room/:roomId");
  return <Room roomId={params?.roomId?.toUpperCase() ?? ""} />;
}

function Router() {
  return (
    <Switch>
      <Route path="/" component={Home} />
      <Route path="/room/:roomId" component={RoomRoute} />
      <Route path="/404" component={NotFound} />
      <Route component={NotFound} />
    </Switch>
  );
}

function App() {
  return (
    <ErrorBoundary>
      <TooltipProvider><Toaster /><Router /></TooltipProvider>
    </ErrorBoundary>
  );
}

export default App;
