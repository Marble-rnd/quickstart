'use strict';

// read env vars from .env file
require('dotenv').config();
const { Configuration, PlaidApi, Products, PlaidEnvironments, CraCheckReportProduct } = require('plaid');
const util = require('util');
const { v4: uuidv4 } = require('uuid');
const express = require('express');
const bodyParser = require('body-parser');
const moment = require('moment');
const cors = require('cors');

const APP_PORT = process.env.APP_PORT || 8000;
const PLAID_CLIENT_ID = process.env.PLAID_CLIENT_ID;
const PLAID_SECRET = process.env.PLAID_SECRET;
const PLAID_ENV = process.env.PLAID_ENV || 'sandbox';

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// PLAID_PRODUCTS is a comma-separated list of products to use when initializing
// Link. Note that this list must contain 'assets' in order for the app to be
// able to create and retrieve asset reports.
const PLAID_PRODUCTS = (process.env.PLAID_PRODUCTS || Products.Transactions).split(
  ',',
);

// PLAID_COUNTRY_CODES is a comma-separated list of countries for which users
// will be able to select institutions from.
const PLAID_COUNTRY_CODES = (process.env.PLAID_COUNTRY_CODES || 'US').split(
  ',',
);

// Parameters used for the OAuth redirect Link flow.
//
// Set PLAID_REDIRECT_URI to 'http://localhost:3000'
// The OAuth redirect flow requires an endpoint on the developer's website
// that the bank website should redirect to. You will need to configure
// this redirect URI for your client ID through the Plaid developer dashboard
// at https://dashboard.plaid.com/team/api.
const PLAID_REDIRECT_URI = process.env.PLAID_REDIRECT_URI || '';

// Parameter used for OAuth in Android. This should be the package name of your app,
// e.g. com.plaid.linksample
const PLAID_ANDROID_PACKAGE_NAME = process.env.PLAID_ANDROID_PACKAGE_NAME || '';

// We store the access_token in memory - in production, store it in a secure
// persistent data store
let ACCESS_TOKEN = null;
let USER_TOKEN = null;
let PUBLIC_TOKEN = null;
let ITEM_ID = null;
let ACCOUNT_ID = null;
// The payment_id is only relevant for the UK/EU Payment Initiation product.
// We store the payment_id in memory - in production, store it in a secure
// persistent data store along with the Payment metadata, such as userId .
let PAYMENT_ID = null;
// The transfer_id and authorization_id are only relevant for Transfer ACH product.
// We store the transfer_id in memory - in production, store it in a secure
// persistent data store
let AUTHORIZATION_ID = null;
let TRANSFER_ID = null;

// Initialize the Plaid client
// Find your API keys in the Dashboard (https://dashboard.plaid.com/account/keys)

const configuration = new Configuration({
  basePath: PlaidEnvironments[PLAID_ENV],
  baseOptions: {
    headers: {
      'PLAID-CLIENT-ID': PLAID_CLIENT_ID,
      'PLAID-SECRET': PLAID_SECRET,
      'Plaid-Version': '2020-09-14',
    },
  },
});

const client = new PlaidApi(configuration);

const app = express();
app.use(
  bodyParser.urlencoded({
    extended: false,
  }),
);
app.use(bodyParser.json());
app.use(cors());

app.post('/api/info', function (request, response, next) {
  response.json({
    item_id: ITEM_ID,
    access_token: ACCESS_TOKEN,
    products: PLAID_PRODUCTS,
  });
});

// Create a link token with configs which we can then use to initialize Plaid Link client-side.
// See https://plaid.com/docs/#create-link-token
app.post('/api/create_link_token', function (request, response, next) {
  Promise.resolve()
    .then(async function () {
      const configs = {
        user: {
          // This should correspond to a unique id for the current user.
          client_user_id: 'user-id',
        },
        client_name: 'Plaid Quickstart',
        products: PLAID_PRODUCTS,
        country_codes: PLAID_COUNTRY_CODES,
        language: 'en',
      };

      if (PLAID_REDIRECT_URI !== '') {
        configs.redirect_uri = PLAID_REDIRECT_URI;
      }

      if (PLAID_ANDROID_PACKAGE_NAME !== '') {
        configs.android_package_name = PLAID_ANDROID_PACKAGE_NAME;
      }
      if (PLAID_PRODUCTS.includes(Products.Statements)) {
        const statementConfig = {
          end_date: moment().format('YYYY-MM-DD'),
          start_date: moment().subtract(30, 'days').format('YYYY-MM-DD'),
        }
        configs.statements = statementConfig;
      }

      if (PLAID_PRODUCTS.some(product => product.startsWith("cra_"))) {
        configs.user_token = USER_TOKEN;
        configs.cra_options = {
          days_requested: 60
        };
        configs.consumer_report_permissible_purpose = 'ACCOUNT_REVIEW_CREDIT';
      }
      const createTokenResponse = await client.linkTokenCreate(configs);
      prettyPrintResponse(createTokenResponse);
      response.json(createTokenResponse.data);
    })
    .catch(next);
});

// Create a user token which can be used for Plaid Check, Income, or Multi-Item link flows
// https://plaid.com/docs/api/users/#usercreate
app.post('/api/create_user_token', function (request, response, next) {
  Promise.resolve()
    .then(async function () {

      const request = {
        // Typically this will be a user ID number from your application. 
        client_user_id: 'user_' + uuidv4()
      }

      if (PLAID_PRODUCTS.some(product => product.startsWith("cra_"))) {
        request.consumer_report_user_identity = {
          date_of_birth: '1980-07-31',
          first_name: 'Harry',
          last_name: 'Potter',
          phone_numbers: ['+16174567890'],
          emails: ['harrypotter@example.com'],
          primary_address: {
            city: 'New York',
            region: 'NY',
            street: '4 Privet Drive',
            postal_code: '11111',
            country: 'US'
          }
        }
      }
      const user = await client.userCreate(request);
      USER_TOKEN = user.data.user_token
      response.json(user.data);
    }).catch(next);
});


// Create a link token with configs which we can then use to initialize Plaid Link client-side
// for a 'payment-initiation' flow.
// See:
// - https://plaid.com/docs/payment-initiation/
// - https://plaid.com/docs/#payment-initiation-create-link-token-request
app.post(
  '/api/create_link_token_for_payment',
  function (request, response, next) {
    Promise.resolve()
      .then(async function () {
        const createRecipientResponse =
          await client.paymentInitiationRecipientCreate({
            name: 'Harry Potter',
            iban: 'GB33BUKB20201555555555',
            address: {
              street: ['4 Privet Drive'],
              city: 'Little Whinging',
              postal_code: '11111',
              country: 'GB',
            },
          });
        const recipientId = createRecipientResponse.data.recipient_id;
        prettyPrintResponse(createRecipientResponse);

        const createPaymentResponse =
          await client.paymentInitiationPaymentCreate({
            recipient_id: recipientId,
            reference: 'paymentRef',
            amount: {
              value: 1.23,
              currency: 'GBP',
            },
          });
        prettyPrintResponse(createPaymentResponse);
        const paymentId = createPaymentResponse.data.payment_id;

        // We store the payment_id in memory for demo purposes - in production, store it in a secure
        // persistent data store along with the Payment metadata, such as userId.
        PAYMENT_ID = paymentId;

        const configs = {
          client_name: 'Plaid Quickstart',
          user: {
            // This should correspond to a unique id for the current user.
            // Typically, this will be a user ID number from your application.
            // Personally identifiable information, such as an email address or phone number, should not be used here.
            client_user_id: uuidv4(),
          },
          // Institutions from all listed countries will be shown.
          country_codes: PLAID_COUNTRY_CODES,
          language: 'en',
          // The 'payment_initiation' product has to be the only element in the 'products' list.
          products: [Products.PaymentInitiation],
          payment_initiation: {
            payment_id: paymentId,
          },
        };
        if (PLAID_REDIRECT_URI !== '') {
          configs.redirect_uri = PLAID_REDIRECT_URI;
        }
        const createTokenResponse = await client.linkTokenCreate(configs);
        prettyPrintResponse(createTokenResponse);
        response.json(createTokenResponse.data);
      })
      .catch(next);
  },
);

// Exchange token flow - exchange a Link public_token for
// an API access_token
// https://plaid.com/docs/#exchange-token-flow
app.post('/api/set_access_token', function (request, response, next) {
  PUBLIC_TOKEN = request.body.public_token;
  Promise.resolve()
    .then(async function () {
      const tokenResponse = await client.itemPublicTokenExchange({
        public_token: PUBLIC_TOKEN,
      });
      prettyPrintResponse(tokenResponse);
      ACCESS_TOKEN = tokenResponse.data.access_token;
      ITEM_ID = tokenResponse.data.item_id;
      response.json({
        // the 'access_token' is a private token, DO NOT pass this token to the frontend in your production environment
        access_token: ACCESS_TOKEN,
        item_id: ITEM_ID,
        error: null,
      });
    })
    .catch(next);
});

// Retrieve ACH or ETF Auth data for an Item's accounts
// https://plaid.com/docs/#auth
app.get('/api/auth', function (request, response, next) {
  Promise.resolve()
    .then(async function () {
      const authResponse = await client.authGet({
        access_token: ACCESS_TOKEN,
      });
      prettyPrintResponse(authResponse);
      response.json(authResponse.data);
    })
    .catch(next);
});

// Retrieve Transactions for an Item
// https://plaid.com/docs/#transactions
app.get('/api/transactions', function (request, response, next) {
  Promise.resolve()
    .then(async function () {
      // Set cursor to empty to receive all historical updates
      let cursor = null;

      // New transaction updates since "cursor"
      let added = [];
      let modified = [];
      // Removed transaction ids
      let removed = [];
      let hasMore = true;
      // Iterate through each page of new transaction updates for item
      while (hasMore) {
        const request = {
          access_token: ACCESS_TOKEN,
          cursor: cursor,
        };
        const response = await client.transactionsSync(request)
        const data = response.data;

        // If no transactions are available yet, wait and poll the endpoint.
        // Normally, we would listen for a webhook, but the Quickstart doesn't
        // support webhooks. For a webhook example, see
        // https://github.com/plaid/tutorial-resources or
        // https://github.com/plaid/pattern
        cursor = data.next_cursor;
        if (cursor === "") {
          await sleep(2000);
          continue;
        }

        // Add this page of results
        added = added.concat(data.added);
        modified = modified.concat(data.modified);
        removed = removed.concat(data.removed);
        hasMore = data.has_more;

        prettyPrintResponse(response);
      }

      const compareTxnsByDateAscending = (a, b) => (a.date > b.date) - (a.date < b.date);
      // Return the 8 most recent transactions
      const recently_added = [...added].sort(compareTxnsByDateAscending).slice(-8);
      response.json({ latest_transactions: recently_added });
    })
    .catch(next);
});

// Retrieve Investment Transactions for an Item
// https://plaid.com/docs/#investments
app.get('/api/investments_transactions', function (request, response, next) {
  Promise.resolve()
    .then(async function () {
      const startDate = moment().subtract(30, 'days').format('YYYY-MM-DD');
      const endDate = moment().format('YYYY-MM-DD');
      const configs = {
        access_token: ACCESS_TOKEN,
        start_date: startDate,
        end_date: endDate,
      };
      const investmentTransactionsResponse =
        await client.investmentsTransactionsGet(configs);
      prettyPrintResponse(investmentTransactionsResponse);
      response.json({
        error: null,
        investments_transactions: investmentTransactionsResponse.data,
      });
    })
    .catch(next);
});

// Retrieve Identity for an Item
// https://plaid.com/docs/#identity
app.get('/api/identity', function (request, response, next) {
  Promise.resolve()
    .then(async function () {
      const identityResponse = await client.identityGet({
        access_token: ACCESS_TOKEN,
      });
      prettyPrintResponse(identityResponse);
      response.json({ identity: identityResponse.data.accounts });
    })
    .catch(next);
});

// Retrieve real-time Balances for each of an Item's accounts
// https://plaid.com/docs/#balance
app.get('/api/balance', function (request, response, next) {
  Promise.resolve()
    .then(async function () {
      const balanceResponse = await client.accountsBalanceGet({
        access_token: ACCESS_TOKEN,
      });
      prettyPrintResponse(balanceResponse);
      response.json(balanceResponse.data);
    })
    .catch(next);
});

// Retrieve Holdings for an Item
// https://plaid.com/docs/#investments
app.get('/api/holdings', function (request, response, next) {
  Promise.resolve()
    .then(async function () {
      const holdingsResponse = await client.investmentsHoldingsGet({
        access_token: ACCESS_TOKEN,
      });
      prettyPrintResponse(holdingsResponse);
      response.json({ error: null, holdings: holdingsResponse.data });
    })
    .catch(next);
});

// Retrieve Liabilities for an Item
// https://plaid.com/docs/#liabilities
app.get('/api/liabilities', function (request, response, next) {
  Promise.resolve()
    .then(async function () {
      const liabilitiesResponse = await client.liabilitiesGet({
        access_token: ACCESS_TOKEN,
      });
      prettyPrintResponse(liabilitiesResponse);
      response.json({ error: null, liabilities: liabilitiesResponse.data });
    })
    .catch(next);
});

// Retrieve information about an Item
// https://plaid.com/docs/#retrieve-item
app.get('/api/item', function (request, response, next) {
  Promise.resolve()
    .then(async function () {
      // Pull the Item - this includes information about available products,
      // billed products, webhook information, and more.
      const itemResponse = await client.itemGet({
        access_token: ACCESS_TOKEN,
      });
      // Also pull information about the institution
      const configs = {
        institution_id: itemResponse.data.item.institution_id,
        country_codes: PLAID_COUNTRY_CODES,
      };
      const instResponse = await client.institutionsGetById(configs);
      prettyPrintResponse(itemResponse);
      response.json({
        item: itemResponse.data.item,
        institution: instResponse.data.institution,
      });
    })
    .catch(next);
});

// Retrieve an Item's accounts
// https://plaid.com/docs/#accounts
app.get('/api/accounts', function (request, response, next) {
  Promise.resolve()
    .then(async function () {
      const accountsResponse = await client.accountsGet({
        access_token: ACCESS_TOKEN,
      });
      prettyPrintResponse(accountsResponse);
      response.json(accountsResponse.data);
    })
    .catch(next);
});

// Create and then retrieve an Asset Report for one or more Items. Note that an
// Asset Report can contain up to 100 items, but for simplicity we're only
// including one Item here.
// https://plaid.com/docs/#assets
app.get('/api/assets', function (request, response, next) {
  Promise.resolve()
    .then(async function () {
      // You can specify up to two years of transaction history for an Asset
      // Report.
      const daysRequested = 10;

      // The `options` object allows you to specify a webhook for Asset Report
      // generation, as well as information that you want included in the Asset
      // Report. All fields are optional.
      const options = {
        client_report_id: 'Custom Report ID #123',
        // webhook: 'https://your-domain.tld/plaid-webhook',
        user: {
          client_user_id: 'Custom User ID #456',
          first_name: 'Alice',
          middle_name: 'Bobcat',
          last_name: 'Cranberry',
          ssn: '123-45-6789',
          phone_number: '555-123-4567',
          email: 'alice@example.com',
        },
      };
      const configs = {
        access_tokens: [ACCESS_TOKEN],
        days_requested: daysRequested,
        options,
      };
      const assetReportCreateResponse = await client.assetReportCreate(configs);
      prettyPrintResponse(assetReportCreateResponse);
      const assetReportToken =
        assetReportCreateResponse.data.asset_report_token;
      const getResponse = await getAssetReportWithRetries(
        client,
        assetReportToken,
      );
      const pdfRequest = {
        asset_report_token: assetReportToken,
      };

      const pdfResponse = await client.assetReportPdfGet(pdfRequest, {
        responseType: 'arraybuffer',
      });
      prettyPrintResponse(getResponse);
      prettyPrintResponse(pdfResponse);
      response.json({
        json: getResponse.data.report,
        pdf: pdfResponse.data.toString('base64'),
      });
    })
    .catch(next);
});

app.get('/api/statements', function (request, response, next) {
  Promise.resolve()
    .then(async function () {
      const statementsListResponse = await client.statementsList({ access_token: ACCESS_TOKEN });
      prettyPrintResponse(statementsListResponse);
      const pdfRequest = {
        access_token: ACCESS_TOKEN,
        statement_id: statementsListResponse.data.accounts[0].statements[0].statement_id
      };

      const statementsDownloadResponse = await client.statementsDownload(pdfRequest, {
        responseType: 'arraybuffer',
      });
      prettyPrintResponse(statementsDownloadResponse);
      response.json({
        json: statementsListResponse.data,
        pdf: statementsDownloadResponse.data.toString('base64'),
      });
    })
    .catch(next);
});

// This functionality is only relevant for the UK/EU Payment Initiation product.
// Retrieve Payment for a specified Payment ID
app.get('/api/payment', function (request, response, next) {
  Promise.resolve()
    .then(async function () {
      const paymentGetResponse = await client.paymentInitiationPaymentGet({
        payment_id: PAYMENT_ID,
      });
      prettyPrintResponse(paymentGetResponse);
      response.json({ error: null, payment: paymentGetResponse.data });
    })
    .catch(next);
});

// This endpoint is still supported but is no longer recommended
// For Income best practices, see https://github.com/plaid/income-sample instead
app.get('/api/income/verification/paystubs', function (request, response, next) {
  Promise.resolve()
    .then(async function () {
      const paystubsGetResponse = await client.incomeVerificationPaystubsGet({
        access_token: ACCESS_TOKEN
      });
      prettyPrintResponse(paystubsGetResponse);
      response.json({ error: null, paystubs: paystubsGetResponse.data })
    })
    .catch(next);
})

const server = app.listen(APP_PORT, function () {
  console.log('plaid-quickstart server listening on port ' + APP_PORT);
});

const prettyPrintResponse = (response) => {
  console.log(util.inspect(response.data, { colors: true, depth: 4 }));
};

// This is a helper function to poll for the completion of an Asset Report and
// then send it in the response to the client. Alternatively, you can provide a
// webhook in the `options` object in your `/asset_report/create` request to be
// notified when the Asset Report is finished being generated.

const getAssetReportWithRetries = (
  plaidClient,
  asset_report_token,
  ms = 1000,
  retriesLeft = 20,
) => {
  const request = {
    asset_report_token,
  };

  return pollWithRetries(
    async () => {
      return await plaidClient.assetReportGet(request);
    }
  );
}

const formatError = (error) => {
  return {
    error: { ...error.data, status_code: error.status },
  };
};

app.get('/api/transfer_authorize', function (request, response, next) {
  Promise.resolve()
    .then(async function () {
      const accountsResponse = await client.accountsGet({
        access_token: ACCESS_TOKEN,
      });
      ACCOUNT_ID = accountsResponse.data.accounts[0].account_id;

      const transferAuthorizationCreateResponse = await client.transferAuthorizationCreate({
        access_token: ACCESS_TOKEN,
        account_id: ACCOUNT_ID,
        type: 'debit',
        network: 'ach',
        amount: '1.00',
        ach_class: 'ppd',
        user: {
          legal_name: 'FirstName LastName',
          email_address: 'foobar@email.com',
          address: {
            street: '123 Main St.',
            city: 'San Francisco',
            region: 'CA',
            postal_code: '94053',
            country: 'US',
          },
        },
      });
      prettyPrintResponse(transferAuthorizationCreateResponse);
      AUTHORIZATION_ID = transferAuthorizationCreateResponse.data.authorization.id;
      response.json(transferAuthorizationCreateResponse.data);
    })
    .catch(next);
});


app.get('/api/transfer_create', function (request, response, next) {
  Promise.resolve()
    .then(async function () {
      const transferCreateResponse = await client.transferCreate({
        access_token: ACCESS_TOKEN,
        account_id: ACCOUNT_ID,
        authorization_id: AUTHORIZATION_ID,
        description: 'Debit',
      });
      prettyPrintResponse(transferCreateResponse);
      TRANSFER_ID = transferCreateResponse.data.transfer.id
      response.json({
        error: null,
        transfer: transferCreateResponse.data.transfer,
      });
    })
    .catch(next);
});

app.get('/api/signal_evaluate', function (request, response, next) {
  Promise.resolve()
    .then(async function () {
      const accountsResponse = await client.accountsGet({
        access_token: ACCESS_TOKEN,
      });
      ACCOUNT_ID = accountsResponse.data.accounts[0].account_id;

      const signalEvaluateResponse = await client.signalEvaluate({
        access_token: ACCESS_TOKEN,
        account_id: ACCOUNT_ID,
        client_transaction_id: 'txn1234',
        amount: 100.00,
      });
      prettyPrintResponse(signalEvaluateResponse);
      response.json(signalEvaluateResponse.data);
    })
    .catch(next);
});

// Retrieve CRA Base Report and PDF
// Base report: https://plaid.com/docs/check/api/#cracheck_reportbase_reportget
// PDF: https://plaid.com/docs/check/api/#cracheck_reportpdfget
app.get('/api/cra/get_base_report', function (request, response, next) {
  Promise.resolve()
    .then(async function () {
      const getResponse = await getCraBaseReportWithRetries(client, USER_TOKEN);
      prettyPrintResponse(getResponse);

      const pdfResponse = await client.craCheckReportPdfGet({
        user_token: USER_TOKEN,
      }, {
        responseType: 'arraybuffer'
      });

      response.json({
        report: getResponse.data.report,
        pdf: pdfResponse.data.toString('base64'),
      });
    })
    .catch(next);
});

const getCraBaseReportWithRetries = (
  plaidClient,
  userToken
) => pollWithRetries(
  async () => {
    return await plaidClient.craCheckReportBaseReportGet(
      {
        user_token: userToken
      }
    )
  }
);

// Retrieve CRA Income Insights and PDF with Insights
// Income insights: https://plaid.com/docs/check/api/#cracheck_reportincome_insightsget
// PDF w/ income insights: https://plaid.com/docs/check/api/#cracheck_reportpdfget
app.get('/api/cra/get_income_insights', async (req, res, next) => {
  Promise.resolve()
    .then(async function () {
      const getResponse = await getCheckInsightsWithRetries(client, USER_TOKEN)
      prettyPrintResponse(getResponse);

      const pdfResponse = await client.craCheckReportPdfGet({
        user_token: USER_TOKEN,
        add_ons: ['cra_income_insights']
      }, {
        responseType: 'arraybuffer'
      });

      res.json({
        report: getResponse.data.report,
        pdf: pdfResponse.data.toString('base64'),
      });
    })
    .catch(next);
});


const getCheckInsightsWithRetries = (
  plaidClient,
  userToken
) => pollWithRetries(
  async () => {
    return await plaidClient.craCheckReportIncomeInsightsGet(
      {
        user_token: userToken
      }
    );
  }
);

// Retrieve CRA Partner Insights
// https://plaid.com/docs/check/api/#cracheck_reportpartner_insightsget
app.get('/api/cra/get_partner_insights', async (req, res, next) => {
  Promise.resolve()
    .then(async function () {
      const response = await getCheckParnterInsightsWithRetries(client, USER_TOKEN);
      prettyPrintResponse(response);

      res.json(response.data);
    })
    .catch(next);
});


const getCheckParnterInsightsWithRetries = (
  plaidClient,
  userToken
) => pollWithRetries(
  async () => {
    return await plaidClient.craCheckReportPartnerInsightsGet(
      {
        user_token: userToken
      }
    );
  }
);

// Since this quickstart does not support webhooks, this function can be used to poll
// an API that would otherwise be triggered by a webhook.
// For a webhook example, see
// https://github.com/plaid/tutorial-resources or
// https://github.com/plaid/pattern
const pollWithRetries = (
  requestCallback,
  ms = 1000,
  retriesLeft = 20,
) =>
  new Promise((resolve, reject) => {
    requestCallback()
      .then(resolve)
      .catch(() => {
        setTimeout(() => {
          if (retriesLeft === 1) {
            reject('Ran out of retries while polling');
            return;
          }
          pollWithRetries(
            requestCallback,
            ms,
            retriesLeft - 1,
          ).then(resolve);
        }, ms);
      });
  });

// NEW ENDPOINT: Exchange public token for access token for frontend use
app.post('/api/exchange_public_token', function (request, response, next) {
  const publicToken = request.body.public_token;
  
  if (!publicToken) {
    return response.status(400).json({ error: 'public_token is required' });
  }
  
  Promise.resolve()
    .then(async function () {
      const tokenResponse = await client.itemPublicTokenExchange({
        public_token: publicToken,
      });
      prettyPrintResponse(tokenResponse);
      
      // Store for this session (in production, use database)
      ACCESS_TOKEN = tokenResponse.data.access_token;
      ITEM_ID = tokenResponse.data.item_id;
      
      response.json({
        access_token: tokenResponse.data.access_token,
        item_id: tokenResponse.data.item_id,
      });
    })
    .catch(next);
});

// NEW ENDPOINT: Fetch comprehensive financial data for Financial Disclosure
app.post('/api/comprehensive_financial_data', function (request, response, next) {
  const accessToken = request.body.access_token || ACCESS_TOKEN;
  
  if (!accessToken) {
    return response.status(400).json({ error: 'access_token is required' });
  }
  
  Promise.resolve()
    .then(async function () {
      console.log('Fetching comprehensive financial data...');
      
      // Fetch all data types in parallel
      const [
        accountsResponse,
        identityResponse,
        transactionsData,
        balanceResponse,
        liabilitiesResponse,
        incomeResponse,
        assetsResponse,
      ] = await Promise.allSettled([
        // Basic account info
        client.accountsGet({ access_token: accessToken }),
        
        // Identity info
        client.identityGet({ access_token: accessToken }),
        
        // Transactions (last 90 days)
        (async () => {
          const startDate = moment().subtract(90, 'days').format('YYYY-MM-DD');
          const endDate = moment().format('YYYY-MM-DD');
          
          try {
            // Use transactionsGet for comprehensive data
            const response = await client.transactionsGet({
              access_token: accessToken,
              start_date: startDate,
              end_date: endDate,
            });
            return response;
          } catch (error) {
            // If transactionsGet fails, try transactionsSync
            console.log('transactionsGet failed, trying transactionsSync...');
            let cursor = null;
            let added = [];
            let hasMore = true;
            
            while (hasMore) {
              const syncResponse = await client.transactionsSync({
                access_token: accessToken,
                cursor: cursor,
              });
              
              cursor = syncResponse.data.next_cursor;
              if (cursor === "") {
                await sleep(1000);
                continue;
              }
              
              added = added.concat(syncResponse.data.added);
              hasMore = syncResponse.data.has_more;
              
              if (!hasMore || added.length > 100) break;
            }
            
            return { data: { transactions: added, accounts: [], total: added.length } };
          }
        })(),
        
        // Account balances
        client.accountsBalanceGet({ access_token: accessToken }),
        
        
        // Liabilities (if available)
        client.liabilitiesGet({ access_token: accessToken }).catch(err => {
          console.log('Liabilities not available:', err.message);
          // In sandbox, liabilities might not be available for all test accounts
          // This is expected behavior - we'll handle it gracefully
          if (err.response) {
            console.log('Liabilities API error details:', err.response.data);
          }
          return null;
        }),
        
        // Income verification (if available)
        // Note: Income verification requires a separate flow in Plaid, not available via regular access token
        Promise.resolve(null).then(() => {
          console.log('Income verification requires separate flow, using transaction-based calculation');
          return null;
        }),
        
        // Assets (if available) - Note: Assets require a separate report generation flow
        // For now, we'll use account balances as a proxy for assets
        Promise.resolve(null),
      ]);
      
      // Process results
      const accounts = accountsResponse.status === 'fulfilled' ? accountsResponse.value.data.accounts : [];
      const identity = identityResponse.status === 'fulfilled' && identityResponse.value.data.accounts[0]?.owners?.[0] 
        ? identityResponse.value.data.accounts[0].owners[0]
        : { addresses: [], emails: [], names: [], phone_numbers: [] };
      const transactions = transactionsData.status === 'fulfilled' ? transactionsData.value.data.transactions : [];
      const balances = balanceResponse.status === 'fulfilled' ? balanceResponse.value.data.accounts : [];
      
      
      // Liabilities data
      const liabilities = liabilitiesResponse && liabilitiesResponse.status === 'fulfilled' && liabilitiesResponse.value
        ? {
            credit: liabilitiesResponse.value.data.liabilities?.credit || [],
            mortgage: liabilitiesResponse.value.data.liabilities?.mortgage || [],
            student: liabilitiesResponse.value.data.liabilities?.student || [],
          }
        : null;
      
      // Use Income API data if available, otherwise calculate from transactions
      let income;
      if (incomeResponse && incomeResponse.status === 'fulfilled' && incomeResponse.value) {
        // Use actual income data from Plaid Income API
        income = incomeResponse.value.data;
      } else {
        // Fallback: Calculate income from transactions
        const incomeTransactions = transactions.filter(t => 
          t.amount < 0 && // Negative amounts are income in Plaid
          (t.category?.includes('Deposit') || 
           t.category?.includes('Transfer') || 
           t.category?.includes('Payroll') ||
           t.name?.toLowerCase().includes('payroll') ||
           t.name?.toLowerCase().includes('salary'))
        );
        
        const monthlyIncome = incomeTransactions.reduce((sum, t) => sum + Math.abs(t.amount), 0) / 3; // 3 months average
        
        income = {
          projected_yearly_income: monthlyIncome * 12,
          projected_yearly_income_before_tax: monthlyIncome * 12 * 1.25, // Estimate
          income_streams: [{
            name: 'Primary Income',
            monthly_income: monthlyIncome,
            confidence: 0.8,
            days: 90,
          }],
          number_of_income_streams: 1,
        };
      }
      
      // Build comprehensive response
      const comprehensiveData = {
        accounts,
        identity,
        transactions,
        balances,
        income,
        liabilities,
        assets: null, // Asset reports require separate flow
        summary: {
          total_accounts: accounts.length,
          total_transactions: transactions.length,
          has_investments: false,
          has_liabilities: !!liabilities,
        },
      };
      
      console.log('Comprehensive data fetched successfully');
      response.json(comprehensiveData);
    })
    .catch(next);
});

app.use('/api', function (error, request, response, next) {
  console.log(error);
  if (error.response) {
    prettyPrintResponse(error.response);
    response.json(formatError(error.response));
  } else {
    // Handle non-Plaid errors (like TypeErrors)
    console.error('Non-Plaid error:', error.message);
    response.status(500).json({
      error: {
        error_code: 'INTERNAL_ERROR',
        error_message: error.message || 'An internal error occurred',
        error_type: 'INTERNAL'
      }
    });
  }
});