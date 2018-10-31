import { basename, dirname, join, relative, resolve } from "path";
import { fs, withGlobalFS } from "apollo-codegen-core/lib/localfs";

import * as fg from "glob";
import * as minimatch from "minimatch";
import {
  GraphQLSchema,
  extendSchema,
  visit,
  buildASTSchema,
  buildClientSchema
} from "graphql";
import { loadSchema } from "./load-schema";
import { loadQueryDocuments } from "apollo-codegen-core/lib/loading";

export interface EndpointConfig {
  url?: string; // main HTTP endpoint
  subscriptions?: string; // WS endpoint for subscriptions
  headers?: Object; // headers to send when performing operations
  skipSSLValidation?: boolean; // bypass the SSL validation on a HTTPS request
}

export interface SchemaDependency {
  schema?: string;
  endpoint?: EndpointConfig;
  engineKey?: string;
  extends?: string;
  clientSide?: boolean;
}

export interface DocumentSet {
  schema?: string;
  includes: string[];
  excludes: string[];
}

export interface ApolloConfig {
  configFile: string;
  projectFolder: string;
  name?: string;
  schemas?: { [name: string]: SchemaDependency }; // path to JSON introspection, if not provided endpoint will be used
  queries?: DocumentSet[];
  engineEndpoint?: string;
}

function loadEndpointConfig(
  obj: any,
  shouldDefaultURL: boolean
): EndpointConfig | undefined {
  let preSubscriptions: EndpointConfig | undefined;
  if (typeof obj === "string") {
    preSubscriptions = {
      url: obj
    };
  } else {
    preSubscriptions =
      (obj as EndpointConfig | undefined) ||
      (shouldDefaultURL ? { url: "http://localhost:4000/graphql" } : undefined);
  }

  if (
    preSubscriptions &&
    !preSubscriptions.subscriptions &&
    preSubscriptions.url
  ) {
    preSubscriptions.subscriptions = preSubscriptions.url!.replace(
      "http",
      "ws"
    );
  }

  return preSubscriptions;
}

function loadSchemaConfig(
  obj: SchemaDependency,
  defaultEndpoint: boolean
): SchemaDependency {
  return {
    ...obj,
    endpoint: loadEndpointConfig(
      obj.endpoint,
      !obj.engineKey && defaultEndpoint
    ),
    engineKey: process.env.ENGINE_API_KEY || obj.engineKey
  };
}

function loadDocumentSet(obj: any): DocumentSet {
  return {
    schema: obj.schema,
    includes:
      typeof obj.includes === "string"
        ? [obj.includes as string]
        : obj.includes
          ? (obj.includes as string[])
          : ["**"],
    excludes:
      typeof obj.excludes === "string"
        ? [obj.excludes as string]
        : obj.excludes
          ? (obj.excludes as string[])
          : ["node_modules/**"]
  };
}

function getSchemasFromServices({
  obj,
  defaultEndpoint,
  defaultSchema
}: {
  obj: any;
  defaultEndpoint: boolean;
  defaultSchema: boolean;
}) {
  const schemas: { [key: string]: SchemaDependency } = {};
  if (obj.services) {
    const [[serviceName, schemaRef]] = Object.entries(obj.services);

    schemas[serviceName] = {
      endpoint: isUrl(schemaRef)
        ? loadEndpointConfig(schemaRef, true)
        : undefined,
      engineKey: process.env.ENGINE_API_KEY,
      clientSide: false,
      schema: isFile(schemaRef) ? schemaRef : null
    };
  }

  if (Object.keys(schemas).length === 0 && defaultSchema) {
    schemas.default = loadSchemaConfig({}, defaultEndpoint);
  }

  if (obj.clientSchema) {
    schemas.default = {
      schema: obj.clientSchema,
      clientSide: true,
      extends: schemas ? Object.keys(schemas)[0] : undefined
    };
  }

  return schemas;
}

function isUrl(maybeUrl: string) {
  return !!maybeUrl.match(/http/);
}

function isFile(maybeFile: string) {
  return !isUrl(maybeFile) && fs.existsSync(maybeFile);
}

export function loadConfig(
  obj: any,
  configFile: string,
  configDir: string,
  defaultEndpoint: boolean,
  defaultSchema: boolean
): ApolloConfig {
  const schemas = getSchemasFromServices({
    obj,
    defaultEndpoint,
    defaultSchema
  });

  return {
    configFile,
    projectFolder: configDir,
    schemas,
    name: basename(configDir),
    queries: (obj.queries
      ? Array.isArray(obj.queries)
        ? (obj.queries as any[])
        : [obj.queries]
      : Object.keys(schemas).length == 1
        ? [{ schema: Object.keys(schemas)[0] }]
        : []
    ).map(d => loadDocumentSet(d)),
    engineEndpoint: obj.engineEndpoint
  };
}

export function loadConfigFromFile(
  file: string,
  defaultEndpoint: boolean,
  defaultSchema: boolean
): ApolloConfig {
  if (file.endsWith(".js")) {
    const filepath = resolve(file);
    delete require.cache[require.resolve(filepath)];
    return loadConfig(
      require(filepath),
      filepath,
      dirname(filepath),
      defaultEndpoint,
      defaultSchema
    );
  } else if (file.endsWith("package.json")) {
    const apolloKey = JSON.parse(fs.readFileSync(file).toString()).apollo;
    if (apolloKey) {
      return loadConfig(
        apolloKey,
        file,
        dirname(file),
        defaultEndpoint,
        defaultSchema
      );
    } else {
      return loadConfig(
        {},
        file,
        dirname(file),
        defaultEndpoint,
        defaultSchema
      );
    }
  } else {
    throw new Error("Unsupported config file format");
  }
}

export function findAndLoadConfig(
  dir: string,
  defaultEndpoint: boolean,
  defaultSchema: boolean
): ApolloConfig {
  if (fs.existsSync(join(dir, "apollo.config.js"))) {
    return loadConfigFromFile(
      join(dir, "apollo.config.js"),
      defaultEndpoint,
      defaultSchema
    );
  } else if (fs.existsSync(join(dir, "package.json"))) {
    return loadConfigFromFile(
      join(dir, "package.json"),
      defaultEndpoint,
      defaultSchema
    );
  } else {
    return loadConfig({}, dir, dir, defaultEndpoint, defaultSchema);
  }
}

export interface ResolvedDocumentSet {
  schema?: GraphQLSchema;
  endpoint?: EndpointConfig;
  engineKey?: string;

  documentPaths: string[];

  originalSet: DocumentSet;
}

export async function resolveSchema({
  name,
  config,
  tag
}: {
  name: string;
  config: ApolloConfig;
  tag?: string;
}): Promise<GraphQLSchema | undefined> {
  const referredSchema = (config.schemas || {})[name];

  const loadAsAST = () => {
    const ast = loadQueryDocuments([referredSchema.schema!])[0];
    if (referredSchema.clientSide) {
      visit(ast, {
        enter(node) {
          if (node.kind == "FieldDefinition") {
            (node as any).__client = true;
          }
        }
      });
    }

    return ast;
  };

  return referredSchema.extends
    ? extendSchema(
        (await resolveSchema({
          name: referredSchema.extends,
          config,
          ...(tag && { tag })
        }))!,
        loadAsAST()
      )
    : referredSchema.clientSide
      ? buildASTSchema(loadAsAST())
      : await loadSchema({
          dependency: referredSchema,
          config,
          ...(tag && { tag })
        }).then(introspectionSchema => {
          if (!introspectionSchema) return;
          return buildClientSchema({ __schema: introspectionSchema });
        });
}

export async function resolveDocumentSets(
  config: ApolloConfig,
  needSchema: boolean,
  tag?: string
): Promise<ResolvedDocumentSet[]> {
  return await Promise.all(
    (config.queries || []).map(async doc => {
      const referredSchema = doc.schema
        ? (config.schemas || {})[doc.schema]
        : undefined;

      const schemaPaths: string[] = [];
      let currentSchema = (config.schemas || {})[doc.schema!];
      while (currentSchema) {
        if (currentSchema.schema) {
          schemaPaths.push(currentSchema.schema);
        }

        currentSchema = (config.schemas || {})[currentSchema.extends!];
      }

      return {
        schema:
          needSchema && doc.schema
            ? await resolveSchema({
                name: doc.schema,
                config,
                ...(tag && { tag })
              })
            : undefined,
        endpoint: referredSchema ? referredSchema.endpoint : undefined,
        engineKey: referredSchema ? referredSchema.engineKey : undefined,
        documentPaths: doc.includes
          .flatMap(i =>
            withGlobalFS(() =>
              fg.sync(i, { cwd: config.projectFolder, absolute: true })
            )
          )
          .filter(
            f =>
              ![...doc.excludes, ...schemaPaths].some(e =>
                minimatch(relative(config.projectFolder, f), e)
              )
          ),
        originalSet: doc
      };
    })
  );
}
