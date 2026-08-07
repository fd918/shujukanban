const lark = require('@larksuiteoapi/node-sdk');
const config = require('./config');

const baseConfig = {
  appId: config.appId,
  appSecret: config.appSecret,
  appType: lark.AppType.SelfBuild,
  domain: lark.Domain.Feishu,
};

const client = new lark.Client(baseConfig);

function userTokenOption(accessToken) {
  return lark.withUserAccessToken(accessToken);
}

module.exports = {
  lark,
  baseConfig,
  client,
  userTokenOption,
};
