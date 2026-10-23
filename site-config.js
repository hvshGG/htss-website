/* The current static site uses the same FormSubmit recipient as the live site.
   SMTP on Node remains an optional alternative; see DEPLOYMENT.md.
   Never place SMTP passwords or private API keys in this public file.
   The Node server serves this configuration from environment variables. */
window.HTSS_CONFIG = Object.freeze({
  contactEmail: 'info@htss-co.kz',
  contactPhone: '+77015919386',
  contactEndpoint: 'https://formsubmit.co/ajax/info%40htss-co.kz',
  delivery: 'formsubmit'
});
