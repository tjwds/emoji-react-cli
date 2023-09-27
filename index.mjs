const [, , targetId, reaction, ...optionalMessage] = process.argv;

const exampleString =
  "JMAP_USERNAME=username JMAP_TOKEN=token node index.mjs (message id or thread id) (reaction) (...optional text to send)";

if (!reaction) {
  console.log("Invoke with a message ID to react to and a reaction to send.");
  console.log(exampleString);
  process.exit(1);
}

if (!process.env.JMAP_USERNAME || !process.env.JMAP_TOKEN) {
  console.log("Please set your JMAP_USERNAME and JMAP_TOKEN");
  console.log(exampleString);

  process.exit(1);
}

// TODO validate all input

const hostname = process.env.JMAP_HOSTNAME || "api.fastmail.com";
const username = process.env.JMAP_USERNAME;

const authUrl = `https://${hostname}/.well-known/jmap`;
const headers = {
  "Content-Type": "application/json",
  Authorization: `Bearer ${process.env.JMAP_TOKEN}`,
};

const getSession = async () => {
  const response = await fetch(authUrl, {
    method: "GET",
    headers,
  });
  return response.json();
};

// TODO make a version that works with messageId
const threadQuery = async (apiUrl, accountId) => {
  const response = await fetch(apiUrl, {
    method: "POST",
    headers,
    body: JSON.stringify({
      using: ["urn:ietf:params:jmap:core", "urn:ietf:params:jmap:mail"],
      methodCalls: [
        [
          "Thread/get",
          {
            accountId,
            ids: [targetId],
          },
          "0",
        ],
        [
          "Email/get",
          {
            accountId,
            "#ids": {
              resultOf: "0",
              name: "Thread/get",
              path: "/list/*/emailIds",
            },
          },
          "1",
        ],
      ],
    }),
  });
  const data = await response.json();

  // XXX just grab the last item in the array (_probably_ what you want anyway)
  return data.methodResponses[1][1].list.at(-1);
};

const mailboxQuery = async (apiUrl, accountId) => {
  const response = await fetch(apiUrl, {
    method: "POST",
    headers,
    body: JSON.stringify({
      using: [
        "urn:ietf:params:jmap:core",
        "urn:ietf:params:jmap:mail",
        "urn:ietf:params:jmap:submission",
      ],
      methodCalls: [
        ["Mailbox/query", { accountId, filter: { name: "Drafts" } }, "a"],
        ["Mailbox/query", { accountId, filter: { name: "Sent" } }, "b"],
        ["Identity/get", { accountId, ids: null }, "a"],
      ],
    }),
  });
  const data = await response.json();

  return {
    draftId: data["methodResponses"][0][1].ids[0],
    sentId: data["methodResponses"][1][1].ids[0],
    identityId: data["methodResponses"][2][1].list.filter(
      (identity) => identity.email === username
    )[0].id,
  };
};

const react = async (apiUrl, accountId, mailboxData, targetMessage) => {
  const { messageId, subject, from } = targetMessage;
  const { draftId, sentId, identityId } = mailboxData;

  const bodyValues = {
    body: { value: reaction, charset: "utf-8" },
  };

  const draftObject = {
    from: [{ email: username }],
    to: [{ email: from[0].email }],
    subject,
    keywords: { $draft: true },
    mailboxIds: { [draftId]: true },
    bodyValues,
    inReplyTo: messageId,
    references: messageId,
  };

  if (optionalMessage.length) {
    bodyValues.normalBody = {
      value: optionalMessage.join(" "),
      charset: "utf-8",
    };
    draftObject.bodyStructure = {
      type: "multipart/mixed",
      subParts: [
        { partId: "body", type: "text/plain", disposition: "reaction" },
        { partId: "normalBody", type: "text/plain" },
      ],
    };
  } else {
    draftObject.textBody = [
      { partId: "body", type: "text/plain", disposition: "reaction" },
    ];
  }

  const response = await fetch(apiUrl, {
    method: "POST",
    headers,
    body: JSON.stringify({
      using: [
        "urn:ietf:params:jmap:core",
        "urn:ietf:params:jmap:mail",
        "urn:ietf:params:jmap:submission",
      ],
      methodCalls: [
        ["Email/set", { accountId, create: { draft: draftObject } }, "a"],
        [
          "EmailSubmission/set",
          {
            accountId,
            onSuccessUpdateEmail: {
              "#sendIt": {
                "keywords/$draft": null,
                [`mailboxIds/${draftId}`]: null,
                [`mailboxIds/${sentId}`]: true,
              },
            },
            create: { sendIt: { emailId: "#draft", identityId } },
          },
          "b",
        ],
      ],
    }),
  });

  const data = await response.json();
  console.log(JSON.stringify(data, null, 2));
};

const run = async () => {
  const session = await getSession();
  const apiUrl = session.apiUrl;
  const accountId = session.primaryAccounts["urn:ietf:params:jmap:mail"];
  let targetReplyTo;
  try {
    targetReplyTo = await threadQuery(apiUrl, accountId);
  } catch (e) {
    console.log(e);
    console.log("Can't find a message for that id.");
  }
  const mailboxData = await mailboxQuery(apiUrl, accountId);
  await react(apiUrl, accountId, mailboxData, targetReplyTo);
  console.log("done.");
};

run();
