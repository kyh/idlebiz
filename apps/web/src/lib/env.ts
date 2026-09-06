// Stripe is optional; missing keys disable Connect without blocking the landing page.
export const env = {
  STRIPE_CLIENT_ID: process.env.STRIPE_CLIENT_ID,
  STRIPE_SECRET_KEY: process.env.STRIPE_SECRET_KEY,
};
