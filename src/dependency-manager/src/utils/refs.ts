import crypto from 'crypto';
import { ComponentSlugUtils, ComponentVersionSlugUtils, EnvironmentSlugUtils, GatewaySlugUtils, InterfaceSlugUtils, ParsedSlug, ServiceSlugUtils, ServiceVersionSlugUtils, SlugKind, SlugParser } from './slugs';

export class Refs {

  public static MAX_SUBDOMAIN_LENGTH = 63; // https://en.wikipedia.org/wiki/Domain_Name_System#Domain_name_syntax,_internationalization

  private static URL_SAFE_DELIMITER = '--';
  private static HASH_LENGTH = 7;
  private static DEFAULT_MAX_LENGTH = 63;

  /**
   * tries to split any slug; attempting most specific to least specific
   *
   * @param slug
   * @throws Error if the given slug does not match any valid architect slug formats
   */
  public static try_split_slug<T extends ParsedSlug>(slug: string): T {
    for (const parser of Object.values(Refs.OrderedEntityParsers)) {
      if (parser.validator.test(slug)) {
        return parser.parse(slug);
      }
    }
    throw new Error(`Slug did not match a valid architect reference: ${slug}`);
  }

  public static split<T extends ParsedSlug>(kind: SlugKind, slug: string): T {
    const parser = Refs.OrderedEntityParsers[kind];
    if (parser.validator.test(slug)) {
      return parser.parse(slug);
    } else {
      throw new Error(parser.description);
    }
  }

  public static url_safe_ref(ref: string, max_length: number = Refs.DEFAULT_MAX_LENGTH): string {
    const parsed_slug = Refs.try_split_slug(ref);

    if (parsed_slug.kind === 'gateway') {
      return GatewaySlugUtils.StringLiteral;
    }

    const uri = Refs.to_uri(parsed_slug);
    const hash = Refs.to_digest(uri);

    let url_safe_ref = '';
    if (parsed_slug.environment_account_name) {
      url_safe_ref += parsed_slug.environment_account_name + Refs.URL_SAFE_DELIMITER;
    }
    if (parsed_slug.environment_name) {
      url_safe_ref += parsed_slug.environment_name + Refs.URL_SAFE_DELIMITER;
    }
    if (parsed_slug.component_account_name) {
      url_safe_ref += parsed_slug.component_account_name + Refs.URL_SAFE_DELIMITER;
    }
    if (parsed_slug.component_name) {
      url_safe_ref += parsed_slug.component_name + Refs.URL_SAFE_DELIMITER;
    }
    if (parsed_slug.service_name) {
      url_safe_ref += parsed_slug.service_name + Refs.URL_SAFE_DELIMITER;
    }

    // remove the trailing delimiter
    url_safe_ref = url_safe_ref.slice(0, (-1 * Refs.URL_SAFE_DELIMITER.length));

    // slice if the whole thing is too long
    const max_base_length = max_length - Refs.HASH_LENGTH;
    if (url_safe_ref.length > max_base_length) {
      url_safe_ref = url_safe_ref.slice(0, max_base_length + 1);
      // trim any trailing dashes
      while (url_safe_ref.charAt(url_safe_ref.length - 1) === Refs.URL_SAFE_DELIMITER[0]) {
        url_safe_ref = url_safe_ref.substring(0, url_safe_ref.length - 1);
      }
    }

    // add the hash
    if (parsed_slug.tag) {
      url_safe_ref += Refs.URL_SAFE_DELIMITER;
      url_safe_ref += hash.slice(0, Refs.HASH_LENGTH + 1);
    }

    return url_safe_ref;
  }

  private static to_uri(parsed_slug: ParsedSlug): string {
    return `arc:${parsed_slug.kind}: ''}
      ${parsed_slug.component_account_name ? (':a:' + parsed_slug.component_account_name) : ''}
      ${parsed_slug.component_name ? (':c:' + parsed_slug.component_name) : ''}
      ${parsed_slug.service_name ? (':r:' + parsed_slug.service_name) : ''}
      ${parsed_slug.tag ? (':t:' + parsed_slug.tag) : ''}
      ${parsed_slug.environment_account_name ? (':d:' + parsed_slug.environment_account_name) : ''}
      ${parsed_slug.environment_name ? (':e:' + parsed_slug.environment_name) : ''}`;
  }

  /**
   * This is not a standard base64 md5 hash as we lowercase and replace punctuation
   * This method should not be used for anything beyond conveniently adding entropy to the url_safe_ref.
   * @param uri
   */
  private static to_digest(uri: string): string {
    return crypto.createHash('md5').update(uri)
      .digest("base64") // base64 adds entropy in a more compact string
      .toLowerCase() // we need to makes everything lower which unfortunately removes some entropy
      .replace(/[\\/+=]/g, ''); // we also remove occurances of slash, plus, and equals to make url-safe
  }

  // ordered from most specific to least specific
  private static OrderedEntityParsers: { [key in SlugKind]: SlugParser } = {
    'service_version': {
      description: ServiceVersionSlugUtils.Description,
      validator: ServiceVersionSlugUtils.Validator,
      parse: ServiceVersionSlugUtils.parse,
    },
    'service': {
      description: ServiceSlugUtils.Description,
      validator: ServiceSlugUtils.Validator,
      parse: ServiceSlugUtils.parse,
    },
    'component_version': {
      description: ComponentVersionSlugUtils.Description,
      validator: ComponentVersionSlugUtils.Validator,
      parse: ComponentVersionSlugUtils.parse,
    },
    'component': {
      description: ComponentSlugUtils.Description,
      validator: ComponentSlugUtils.Validator,
      parse: ComponentSlugUtils.parse,
    },
    'interfaces': {
      description: InterfaceSlugUtils.Description,
      validator: InterfaceSlugUtils.Validator,
      parse: InterfaceSlugUtils.parse,
    },
    'gateway': {
      description: GatewaySlugUtils.Description,
      validator: GatewaySlugUtils.Validator,
      parse: GatewaySlugUtils.parse,
    },
    'environment': {
      description: EnvironmentSlugUtils.Description,
      validator: EnvironmentSlugUtils.Validator,
      parse: EnvironmentSlugUtils.parse,
    },
  };
}
