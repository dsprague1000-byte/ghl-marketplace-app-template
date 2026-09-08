/*you provided is a TypeScript code that sets up an Express server and defines several routes
for handling HTTP requests. */
import express, { Express, Request, Response } from "express";
import dotenv from "dotenv";
import { GHL } from "./ghl";
import * as CryptoJS from 'crypto-js'
import { json } from "body-parser";

const path = __dirname + "/ui/dist/";

dotenv.config();
const app: Express = express();
app.use(json({ type: 'application/json' }))

/*`app.use(express.static(path));` is setting up a middleware in the Express server. The
`express.static` middleware is used to serve static files such as HTML, CSS, JavaScript, and images. */
app.use(express.static(path));

/* The line `const ghl = new GHL();` is creating a new instance of the `GHL` class. It is assigning
this instance to the variable `ghl`. This allows you to use the methods and properties defined in
the `GHL` class to interact with the GoHighLevel API. */
const ghl = new GHL();

const port = process.env.PORT;

/*`app.get("/authorize-handler", async (req: Request, res: Response) => { ... })` sets up an example how you can authorization requests */
app.get("/authorize-handler", async (req: Request, res: Response) => {
  const { code } = req.query;
  await ghl.authorizationHandler(code as string);
  res.redirect("https://app.gohighlevel.com/");
});

/*`app.get("/example-api-call", async (req: Request, res: Response) => { ... })` shows you how you can use ghl object to make get requests
 ghl object in abstract would handle all of the authorization part over here. */
app.get("/example-api-call", async (req: Request, res: Response) => {
  if (ghl.checkInstallationExists(req.query.companyId as string)) {
    try {
      const request = await ghl
        .requests(req.query.companyId as string)
        .get(`/users/search?companyId=${req.query.companyId}`, {
          headers: {
            Version: "2021-07-28",
          },
        });
      return res.send(request.data);
    } catch (error) {
      console.log(error);
    }
  }
  return res.send("Installation for this company does not exists");
});

/*`app.get("/example-api-call-location", async (req: Request, res: Response) => { ... })` shows you how you can use ghl object to make get requests
 ghl object in abstract would handle all of the authorization part over here. */
app.get("/example-api-call-location", async (req: Request, res: Response) => {
  try {
    if (ghl.checkInstallationExists(req.params.locationId)) {
      const request = await ghl
        .requests(req.query.locationId as string)
        .get(`/contacts/?locationId=${req.query.locationId}`, {
          headers: {
            Version: "2021-07-28",
          },
        });
      return res.send(request.data);
    } else {
      await ghl.getLocationTokenFromCompanyToken(
        req.query.companyId as string,
        req.query.locationId as string
      );
      const request = await ghl
        .requests(req.query.locationId as string)
        .get(`/contacts/?locationId=${req.query.locationId}`, {
          headers: {
            Version: "2021-07-28",
          },
        });
      return res.send(request.data);
    }
  } catch (error) {
    console.log(error);
    res.send(error).status(400)
  }
});

app.post("/example-webhook-handler",async (req: Request, res: Response) => {
    console.log(req.body)
})


/* The `app.post("/decrypt-sso",async (req: Request, res: Response) => { ... })` route is used to
decrypt session details using ssoKey. */
app.post("/decrypt-sso",async (req: Request, res: Response) => {
  const {key} = req.body || {}
  if(!key){
    return res.status(400).send("Please send valid key")
  }
  try {
    const data = ghl.decryptSSOData(key)
    res.send(data)
  } catch (error) {
    res.status(400).send("Invalid Key")
    console.log(error)  
  }
})

/* P016: OAuth callback receiver.
   Confirms that HighLevel reached the backend without exposing the authorization code. */
app.get("/oauth/callback", async (req: Request, res: Response) => {
  const { code } = req.query;

  // No code — safe informational response only
  if (!code) {
    return res.status(200).send(`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>MPP OAuth Callback</title>
</head>
<body>
  <main>
    <h1>MPP OAuth Callback Received</h1>
    <p>Authorization response reached the MPP backend successfully.</p>
    <p>Authorization code received: No</p>
    <p>You may close this page.</p>
  </main>
</body>
</html>`);
  }

  // Exchange the authorization code using the existing HighLevel template machinery.
  // Never log or echo the code itself.
  await ghl.authorizationHandler(code as string);

  // authorizationHandler catches token-exchange failures internally,
  // so verify that the Location installation was actually stored.
  const locationId = "e44pA2hEK8BXwer0eNYB";
  const tokenStored = ghl.checkInstallationExists(locationId);
  const allKeys = Object.keys(ghl.model.installationObjects);

  if (!tokenStored) {
    return res.status(500).send(`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>MPP OAuth Callback</title>
</head>
<body>
  <main>
    <h1>MPP OAuth Callback Received</h1>
    <p>Authorization code received: Yes</p>
    <p>Token exchange/storage: Failed</p>
    <p>installationObjectsKeys: ${JSON.stringify(allKeys)}</p>
    <p>Check Render logs for [P018-diag] exchange result.</p>
    <p>Do not retry yet. Contact the administrator.</p>
  </main>
</body>
</html>`);
  }

  return res.status(200).send(`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>MPP OAuth Installation Complete</title>
</head>
<body>
  <main>
    <h1>MPP OAuth Installation Complete</h1>
    <p>Authorization code received: Yes</p>
    <p>Token exchange/storage: Complete</p>
    <p>Location: ${locationId}</p>
    <p>You may close this page.</p>
  </main>
</body>
</html>`);
});

app.get("/oauth/token-status", (req: Request, res: Response) => {
  const locationId = "e44pA2hEK8BXwer0eNYB";
  const inst = ghl.model.installationObjects[locationId];
  const allKeys = Object.keys(ghl.model.installationObjects);

  return res.json({
    tokenAvailable: ghl.checkInstallationExists(locationId),
    locationId: inst?.locationId ?? null,
    companyId: inst?.companyId ?? null,
    userType: inst?.userType ?? null,
    expires_in: inst?.expires_in ?? null,
    refreshTokenPresent: !!ghl.model.getRefreshToken(locationId),
    installationObjectsKeys: allKeys,
    storedKey: allKeys.length > 0 ? allKeys[0] : null,
  });
});

app.get("/", function (req, res) {
  res.sendFile(path + "index.html");
});

app.listen(port, () => {
  console.log(`GHL app listening on port ${port}`);
});
