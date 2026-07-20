// Every environment variable this app reads, in one place — see .env.example.
// Both are optional on purpose: the landing page needs no configuration, and
// without them the Stripe Connect routes refuse the flow with a clear message
// instead of failing the deploy. Platform vars (NODE_ENV, VERCEL_*) are not
// app configuration and stay out of here.
export const env = {
  STRIPE_CLIENT_ID: process.env.STRIPE_CLIENT_ID,
  STRIPE_SECRET_KEY: process.env.STRIPE_SECRET_KEY,
};
