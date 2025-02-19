import { ArchitectError } from '../../dependency-manager/src/utils/errors';

export default class MissingContextError extends ArchitectError {
  constructor() {
    super();
    this.name = 'missing_build_context';
    this.message = 'No context was provided. Please specify a path to a valid Architect component.';
  }
}
