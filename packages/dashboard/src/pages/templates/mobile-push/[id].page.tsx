import { GetServerSideProps } from "next";
import { useRouter } from "next/router";
import { validate } from "uuid";

import TemplatePageContent from "../../../components/messages/templatePageContent";
import { MobilePushEditor } from "../../../components/templateEditor";
import { addInitialStateToProps } from "../../../lib/addInitialStateToProps";
import { useAppStorePick } from "../../../lib/appStore";
import { serveMobilePushTemplate } from "../../../lib/messaging";
import { requestContext } from "../../../lib/requestContext";
import { PropsWithInitialState } from "../../../lib/types";

export const getServerSideProps: GetServerSideProps<PropsWithInitialState> =
  requestContext(async (ctx, dfContext) => {
    const id = ctx.params?.id;
    if (typeof id !== "string" || !validate(id)) {
      return { notFound: true };
    }
    const name =
      typeof ctx.query.name === "string" ? ctx.query.name : undefined;
    const state = await serveMobilePushTemplate({
      workspaceId: dfContext.workspace.id,
      messageTemplateId: id,
      defaultName: name,
    });
    return {
      props: addInitialStateToProps({
        dfContext,
        serverInitialState: state,
        props: {},
      }),
    };
  });

export default function MessageEditor() {
  const router = useRouter();
  const templateId =
    typeof router.query.id === "string" ? router.query.id : null;
  const { member } = useAppStorePick(["member"]);
  if (!templateId) return null;
  return (
    <TemplatePageContent>
      <MobilePushEditor
        key={templateId}
        templateId={templateId}
        member={member ?? undefined}
      />
    </TemplatePageContent>
  );
}
