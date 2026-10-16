import { createFileRoute } from "@tanstack/react-router";
import { RemoteChatView } from "~/components/remote/RemoteChatView";

export const Route = createFileRoute("/_chat/remote/$peerId/$chatId")({
  component: RemoteChatRoute,
});
function RemoteChatRoute() {
  const { peerId, chatId } = Route.useParams();
  return <RemoteChatView peerId={peerId} chatId={chatId} />;
}
