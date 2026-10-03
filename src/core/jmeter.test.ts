import assert from "node:assert/strict";
import { test } from "node:test";
import { importJmeter } from "./jmeter.ts";
import { detectFormat, importCollection } from "./interchange.ts";
import { parseXml } from "./xmlMini.ts";

const PLAN = `<?xml version="1.0" encoding="UTF-8"?>
<!-- exportado de JMeter -->
<jmeterTestPlan version="1.2" properties="5.0" jmeter="5.6.3">
  <hashTree>
    <TestPlan guiclass="TestPlanGui" testclass="TestPlan" testname="API Tienda">
      <elementProp name="TestPlan.user_defined_variables" elementType="Arguments">
        <collectionProp name="Arguments.arguments">
          <elementProp name="base" elementType="Argument">
            <stringProp name="Argument.name">base</stringProp>
            <stringProp name="Argument.value">https://api.tienda.test</stringProp>
          </elementProp>
        </collectionProp>
      </elementProp>
    </TestPlan>
    <hashTree>
      <ThreadGroup guiclass="ThreadGroupGui" testclass="ThreadGroup" testname="Grupo">
        <stringProp name="ThreadGroup.num_threads">4</stringProp>
      </ThreadGroup>
      <hashTree>
        <CSVDataSet guiclass="TestBeanGUI" testclass="CSVDataSet" testname="Datos">
          <stringProp name="CSVDataSet.filename">clientes.csv</stringProp>
          <stringProp name="CSVDataSet.variableNames">id, nombre</stringProp>
        </CSVDataSet>
        <hashTree/>
        <HeaderManager guiclass="HeaderPanel" testclass="HeaderManager" testname="Cabeceras">
          <collectionProp name="HeaderManager.headers">
            <elementProp name="" elementType="Header">
              <stringProp name="Header.name">X-Api-Key</stringProp>
              <stringProp name="Header.value">secreto</stringProp>
            </elementProp>
          </collectionProp>
        </HeaderManager>
        <hashTree/>
        <HTTPSamplerProxy guiclass="HttpTestSampleGui" testclass="HTTPSamplerProxy" testname="Login">
          <boolProp name="HTTPSampler.postBodyRaw">true</boolProp>
          <elementProp name="HTTPsampler.Arguments" elementType="Arguments">
            <collectionProp name="Arguments.arguments">
              <elementProp name="" elementType="HTTPArgument">
                <stringProp name="Argument.value">{"user":"ana"}</stringProp>
                <stringProp name="Argument.metadata">=</stringProp>
              </elementProp>
            </collectionProp>
          </elementProp>
          <stringProp name="HTTPSampler.domain">api.tienda.test</stringProp>
          <stringProp name="HTTPSampler.port">443</stringProp>
          <stringProp name="HTTPSampler.protocol">https</stringProp>
          <stringProp name="HTTPSampler.path">/auth/login</stringProp>
          <stringProp name="HTTPSampler.method">POST</stringProp>
          <boolProp name="HTTPSampler.follow_redirects">false</boolProp>
        </HTTPSamplerProxy>
        <hashTree>
          <ResponseAssertion guiclass="AssertionGui" testclass="ResponseAssertion" testname="Es 200">
            <collectionProp name="Assertion.test_strings">
              <stringProp name="17851">200</stringProp>
            </collectionProp>
            <stringProp name="Assertion.test_field">Assertion.response_code</stringProp>
            <intProp name="Assertion.test_type">8</intProp>
          </ResponseAssertion>
          <hashTree/>
        </hashTree>
        <HTTPSamplerProxy guiclass="HttpTestSampleGui" testclass="HTTPSamplerProxy" testname="Listar">
          <elementProp name="HTTPsampler.Arguments" elementType="Arguments">
            <collectionProp name="Arguments.arguments"/>
          </elementProp>
          <stringProp name="HTTPSampler.domain">api.tienda.test</stringProp>
          <stringProp name="HTTPSampler.port">443</stringProp>
          <stringProp name="HTTPSampler.protocol">https</stringProp>
          <stringProp name="HTTPSampler.path">/productos?page=1</stringProp>
          <stringProp name="HTTPSampler.method">GET</stringProp>
          <boolProp name="HTTPSampler.follow_redirects">true</boolProp>
        </HTTPSamplerProxy>
        <hashTree>
          <ResponseAssertion guiclass="AssertionGui" testclass="ResponseAssertion" testname="Trae productos">
            <collectionProp name="Assertion.test_strings">
              <stringProp name="9457">productos</stringProp>
            </collectionProp>
            <stringProp name="Assertion.test_field">Assertion.response_data</stringProp>
            <intProp name="Assertion.test_type">2</intProp>
          </ResponseAssertion>
          <hashTree/>
        </hashTree>
      </hashTree>
    </hashTree>
  </hashTree>
</jmeterTestPlan>`;

test("importa plan JMeter: colección, variables, scope, body raw y aserciones", () => {
  const { collection, warnings } = importJmeter(PLAN);
  assert.equal(collection.name, "API Tienda");
  assert.deepEqual(
    collection.variables.map((v) => [v.key, v.value]),
    [["base", "https://api.tienda.test"], ["id", ""], ["nombre", ""]],
  );
  assert.equal(collection.requests.length, 2);

  const login = collection.requests[0];
  assert.equal(login.name, "Login");
  assert.equal(login.method, "POST");
  assert.equal(login.url, "https://api.tienda.test/auth/login");
  assert.equal(login.bodyMode, "json");
  assert.equal(login.bodyRaw, '{"user":"ana"}');
  assert.equal(login.followRedirects, false);
  assert.equal(login.headers.length, 1);
  assert.equal(login.headers[0]?.key, "X-Api-Key");
  assert.equal(login.headers[0]?.value, "secreto");
  assert.deepEqual(
    login.assertions.map((a) => [a.source, a.op, a.path, a.expected]),
    [["status", "eq", "", "200"]],
  );

  const listar = collection.requests[1];
  assert.equal(listar.method, "GET");
  assert.equal(listar.url, "https://api.tienda.test/productos");
  assert.deepEqual(
    listar.params.map((p) => [p.key, p.value]),
    [["page", "1"]],
  );
  assert.equal(listar.bodyMode, "none");
  assert.equal(listar.followRedirects, true);
  // El HeaderManager del ThreadGroup aplica a todas las peticiones del scope.
  assert.equal(listar.headers.length, 1);
  assert.deepEqual(
    listar.assertions.map((a) => [a.source, a.op, a.expected]),
    [["body", "contains", "productos"]],
  );

  assert.equal(warnings.length, 2);
  assert.match(warnings[0] ?? "", /4 hilos/);
  assert.match(warnings[0] ?? "", /ramp-up 0s/);
  assert.match(warnings[1] ?? "", /clientes\.csv/);
  assert.match(warnings[1] ?? "", /Omnium no lee el CSV/);
});

test("errores: no es un plan y plan sin peticiones", () => {
  assert.throws(() => importJmeter("<otro/>"), /jmeterTestPlan/);
  assert.throws(() => importJmeter('<jmeterTestPlan version="1.2"></jmeterTestPlan>'), /no tiene peticiones/);
  assert.throws(() => importJmeter("<jmeterTestPlan><hashTree/>"), /XML inválido/);
});

test("método no soportado, CSV sin nombres y aserción no mapeable avisan", () => {
  const plan = `<jmeterTestPlan version="1.2"><hashTree>
    <HTTPSamplerProxy testname="Raro">
      <stringProp name="HTTPSampler.domain">api.test</stringProp>
      <stringProp name="HTTPSampler.path">/x</stringProp>
      <stringProp name="HTTPSampler.method">TRACE</stringProp>
      <elementProp name="HTTPsampler.Arguments" elementType="Arguments">
        <collectionProp name="Arguments.arguments"/>
      </elementProp>
    </HTTPSamplerProxy>
    <hashTree>
      <ResponseAssertion testname="Cabeceras">
        <collectionProp name="Assertion.test_strings">
          <stringProp name="1">Set-Cookie</stringProp>
        </collectionProp>
        <stringProp name="Assertion.test_field">Assertion.response_headers</stringProp>
        <intProp name="Assertion.test_type">8</intProp>
      </ResponseAssertion>
      <hashTree/>
    </hashTree>
    <CSVDataSet testname="Sin nombres">
      <stringProp name="CSVDataSet.filename">datos.csv</stringProp>
    </CSVDataSet>
    <hashTree/>
  </hashTree></jmeterTestPlan>`;
  const { collection, warnings } = importJmeter(plan);
  assert.equal(collection.requests[0]?.method, "GET");
  assert.equal(collection.requests[0]?.assertions.length, 0);
  assert.equal(warnings.length, 3);
  assert.match(warnings[0] ?? "", /nombres de variables/);
  assert.match(warnings[1] ?? "", /TRACE/);
  assert.match(warnings[2] ?? "", /Cabeceras/);
});

test("argumentos como query en GET; URL absoluta en path", () => {
  const plan = `<jmeterTestPlan version="1.2"><hashTree>
    <HTTPSamplerProxy testname="Busca">
      <stringProp name="HTTPSampler.path">https://externo.test/buscar</stringProp>
      <stringProp name="HTTPSampler.method">GET</stringProp>
      <elementProp name="HTTPsampler.Arguments" elementType="Arguments">
        <collectionProp name="Arguments.arguments">
          <elementProp name="" elementType="HTTPArgument">
            <stringProp name="Argument.name">q</stringProp>
            <stringProp name="Argument.value">zapatos</stringProp>
          </elementProp>
        </collectionProp>
      </elementProp>
    </HTTPSamplerProxy>
    <hashTree/>
  </hashTree></jmeterTestPlan>`;
  const { collection } = importJmeter(plan);
  const request = collection.requests[0];
  assert.equal(request?.url, "https://externo.test/buscar");
  assert.deepEqual(
    request?.params.map((p) => [p.key, p.value]),
    [["q", "zapatos"]],
  );
  assert.equal(request?.bodyMode, "none");
});

test("detector: contenido y extensión reconocen JMeter", () => {
  assert.equal(detectFormat(PLAN, "plan.txt"), "jmeter");
  assert.equal(detectFormat(PLAN, "plan.jmx"), "jmeter");
  assert.deepEqual(importCollection(PLAN, "plan.jmx").collection.name, "API Tienda");
});

test("importa metadata avanzada: ThreadGroup, JSONPostProcessor, RegexExtractor y header assertions", () => {
  const plan = `<jmeterTestPlan version="1.2"><hashTree>
    <ThreadGroup testname="Carga checkout">
      <stringProp name="ThreadGroup.num_threads">12</stringProp>
      <stringProp name="ThreadGroup.ramp_time">30</stringProp>
      <boolProp name="ThreadGroup.scheduler">true</boolProp>
      <stringProp name="ThreadGroup.duration">120</stringProp>
      <elementProp name="ThreadGroup.main_controller" elementType="LoopController">
        <stringProp name="LoopController.loops">5</stringProp>
      </elementProp>
    </ThreadGroup>
    <hashTree>
      <HTTPSamplerProxy testname="Checkout">
        <stringProp name="HTTPSampler.domain">api.test</stringProp>
        <stringProp name="HTTPSampler.path">/checkout</stringProp>
        <stringProp name="HTTPSampler.method">GET</stringProp>
      </HTTPSamplerProxy>
      <hashTree>
        <JSONPostProcessor testname="Extrae orden">
          <stringProp name="JSONPostProcessor.referenceNames">orderId;total</stringProp>
          <stringProp name="JSONPostProcessor.jsonPathExprs">$.id;$.total</stringProp>
        </JSONPostProcessor>
        <hashTree/>
        <RegexExtractor testname="Token legacy">
          <stringProp name="RegexExtractor.refname">legacyToken</stringProp>
          <stringProp name="RegexExtractor.regex">token=(\\w+)</stringProp>
        </RegexExtractor>
        <hashTree/>
        <ResponseAssertion testname="Content-Type JSON">
          <collectionProp name="Assertion.test_strings"><stringProp name="1">Content-Type: application/json</stringProp></collectionProp>
          <stringProp name="Assertion.test_field">Assertion.response_headers</stringProp>
          <intProp name="Assertion.test_type">2</intProp>
        </ResponseAssertion>
        <hashTree/>
      </hashTree>
    </hashTree>
  </hashTree></jmeterTestPlan>`;
  const { collection, warnings } = importJmeter(plan);
  const request = collection.requests[0]!;
  assert.deepEqual(
    request.extractors.map((extractor) => [extractor.name, extractor.source, extractor.path]),
    [["orderId", "json", "$.id"], ["total", "json", "$.total"]],
  );
  assert.deepEqual(
    request.assertions.map((assertion) => [assertion.source, assertion.op, assertion.path, assertion.expected]),
    [["header", "contains", "Content-Type", "application/json"]],
  );
  assert.ok(warnings.some((warning) => /12 hilos/.test(warning) && /loops 5/.test(warning) && /duración 120s/.test(warning)));
  assert.ok(warnings.some((warning) => /RegexExtractor/.test(warning) && /legacyToken/.test(warning)));
});

test("xmlMini: entidades, CDATA, comentarios y errores con línea", () => {
  const doc = parseXml(`<?xml version="1.0"?><!-- h --><a x="1&amp;2"><b>un &lt; dos</b><![CDATA[<raw>]]></a>`);
  assert.equal(doc.tag, "a");
  assert.equal(doc.attrs.x, "1&2");
  assert.equal(doc.children[0]?.text, "un < dos");
  assert.throws(() => parseXml("<a><b></a>"), /línea 1/);
});
