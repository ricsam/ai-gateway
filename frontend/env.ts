const documentBaseUrl = new URL(document.baseURI);
documentBaseUrl.search = "";
documentBaseUrl.hash = "";

const baseUrl = documentBaseUrl.toString().replace(/\/$/, "");

const env = {
  BASE_URL: baseUrl,
};

export default env;
