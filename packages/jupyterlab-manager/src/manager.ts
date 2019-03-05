// Copyright (c) Jupyter Development Team.
// Distributed under the terms of the Modified BSD License.

// Just need typings
import * as Backbone from 'backbone';

import {
    ManagerBase, shims, IClassicComm, IWidgetRegistryData, ExportMap,
    ExportData, WidgetModel, WidgetView, put_buffers
} from '@jupyter-widgets/base';

import {
  IDisposable
} from '@phosphor/disposable';

import {
  Widget
} from '@phosphor/widgets';

import {
  INotebookModel
} from '@jupyterlab/notebook';

import {
  RenderMimeRegistry
} from '@jupyterlab/rendermime';

import {
  Kernel, KernelMessage, Session
} from '@jupyterlab/services';

import {
  DocumentRegistry
} from '@jupyterlab/docregistry';

import {
  valid
} from 'semver';

import {
  SemVerCache
} from './semvercache';


/**
 * The mime type for a widget view.
 */
export
const WIDGET_VIEW_MIMETYPE = 'application/vnd.jupyter.widget-view+json';

/**
 * The mime type for widget state data.
 */
export
const WIDGET_STATE_MIMETYPE = 'application/vnd.jupyter.widget-state+json';

/**
 * The class name added to an BackboneViewWrapper widget.
 */
const BACKBONEVIEWWRAPPER_CLASS = 'jp-BackboneViewWrapper';

export
class BackboneViewWrapper extends Widget {
  /**
   * Construct a new `Backbone` wrapper widget.
   *
   * @param view - The `Backbone.View` instance being wrapped.
   */
  constructor(view: Backbone.View<any>) {
    super();
    this._view = view;
    view.on('remove', () => {
      this.dispose();
    });
    this.addClass(BACKBONEVIEWWRAPPER_CLASS);
    this.node.appendChild(view.el);
  }

  onAfterAttach(msg: any) {
    this._view.trigger('displayed');
  }

  dispose() {
    this._view = null;
    super.dispose();
  }

  private _view: Backbone.View<any> = null;
}


/**
 * A widget manager that returns phosphor widgets.
 */
export
class WidgetManager extends ManagerBase<Widget> implements IDisposable {
  constructor(context: DocumentRegistry.IContext<INotebookModel>, rendermime: RenderMimeRegistry) {
    super();
    this._context = context;
    this._rendermime = rendermime;

    // Set _handleCommOpen so `this` is captured.
    this._handleCommOpen = async (comm, msg) => {
      let oldComm = new shims.services.Comm(comm);
      await this.handle_comm_open(oldComm, msg);
    };

    context.session.kernelChanged.connect((sender, args) => {
      this._handleKernelChanged(args);
    });

    context.session.statusChanged.connect((sender, args) => {
      this._handleKernelStatusChange(args);
    });

    if (context.session.kernel) {
      this._handleKernelChanged({oldValue: null, newValue: context.session.kernel});
    }
    this._restored = this.restoreWidgets(this._context.model);
  }

  /**
   * Register a new kernel
   */
  _handleKernelChanged({oldValue, newValue}: Session.IKernelChangedArgs) {
    if (oldValue) {
      oldValue.removeCommTarget(this.comm_target_name, this._handleCommOpen);
    }

    if (newValue) {
      newValue.registerCommTarget(this.comm_target_name, this._handleCommOpen);
    }
  }

  _handleKernelStatusChange(args: Kernel.Status) {
    switch (args) {
    case 'connected':
      // TODO: should we clear away any old widgets before restoring?
      this._restored = this.restoreWidgets(this._context.model);
      break;
    case 'restarting':
      this.disconnect();
      break;
    default:
    }
  }

  /**
   * Restore widgets from kernel and saved state.
   */
  async restoreWidgets(notebook: INotebookModel): Promise<void> {
    this._restoring = true;
    try {

      // Steps that needs to be done:
      // 1. Get any widget state from the kernel and open comms with existing state
      // 2. Check saved state for widgets, and restore any that would not overwrite
      //    any live widgets.
      // Attempt to reconstruct any live comms by requesting them from the back-end (1).
      await this._loadFromKernel();
      await this._loadFromNotebook(notebook);
    } finally {
      this._restoring = false;
    }
  }

  /**
   * Load widget state from notebook metadata
   */
  async _loadFromNotebook(notebook: INotebookModel): Promise<void> {
    const widget_md = notebook.metadata.get('widgets') as any;
    // Now that we have mirrored any widgets from the kernel...
    // Restore any widgets from saved state that are not live
    if (widget_md && widget_md[WIDGET_STATE_MIMETYPE]) {
      let state = widget_md[WIDGET_STATE_MIMETYPE];
      state = this.filterExistingModelState(state);
      await this.set_state(state);
    }
  }

  async _loadFromKernel(): Promise<void> {
    if (!this.context.session.kernel) {
      return;
    }
    const comm_ids = await this._get_comm_info();

    // For each comm id, create the comm, get the state, and create a widget.
    const widgets_info = await Promise.all(Object.keys(comm_ids).map(async (comm_id) => {
      const comm = await this._create_comm(this.comm_target_name, comm_id);
      const update_promise = new Promise<Private.ICommUpdateData>((resolve, reject) => {
        comm.on_msg((msg) => {
          put_buffers(msg.content.data.state, msg.content.data.buffer_paths, msg.buffers);
          // A suspected response was received, check to see if
          // it's a state update. If so, resolve.
          if (msg.content.data.method === 'update') {
            resolve({
              comm: comm,
              msg: msg
            });
          }
        });
      });
      comm.send({
        method: 'request_state'
      }, this.callbacks(undefined));

      return await update_promise;
    }));

    // We put in a synchronization barrier here so that we don't have to
    // topologically sort the restored widgets. `new_model` synchronously
    // registers the widget ids before reconstructing their state
    // asynchronously, so promises to every widget reference should be available
    // by the time they are used.
    await Promise.all(widgets_info.map(async widget_info => {
      const content = widget_info.msg.content as any;
      await this.new_model({
        model_name: content.data.state._model_name,
        model_module: content.data.state._model_module,
        model_module_version: content.data.state._model_module_version,
        comm: widget_info.comm,
      }, content.data.state);
    }));
  }



  /**
   * Return a phosphor widget representing the view
   */
  async display_view(msg: any, view: Backbone.View<Backbone.Model>, options: any): Promise<Widget> {
    return (view as any).pWidget || new BackboneViewWrapper(view);
  }

  /**
   * Create a comm.
   */
  async _create_comm(target_name: string, model_id: string, data?: any, metadata?: any, buffers?: ArrayBuffer[] | ArrayBufferView[]): Promise<IClassicComm> {
    let comm = this._context.session.kernel.connectToComm(target_name, model_id);
    if (data || metadata) {
      comm.open(data, metadata, buffers);
    }
    return new shims.services.Comm(comm);
  }

  /**
   * Get the currently-registered comms.
   */
  async _get_comm_info(): Promise<any> {
    const reply = await this._context.session.kernel.requestCommInfo({target: this.comm_target_name});
    return reply.content.comms;
  }

  /**
   * Get whether the manager is disposed.
   *
   * #### Notes
   * This is a read-only property.
   */
  get isDisposed(): boolean {
    return this._context === null;
  }

  /**
   * Dispose the resources held by the manager.
   */
  dispose(): void {
    if (this.isDisposed) {
      return;
    }

    if (this._commRegistration) {
      this._commRegistration.dispose();
    }
    this._context = null;
  }

  /**
   * Resolve a URL relative to the current notebook location.
   */
  async resolveUrl(url: string): Promise<string> {
    const partial = await this.context.urlResolver.resolveUrl(url);
    return this.context.urlResolver.getDownloadUrl(partial);
  }

  /**
   * Load a class and return a promise to the loaded object.
   */
  protected async loadClass(className: string, moduleName: string, moduleVersion: string): Promise<typeof WidgetModel | typeof WidgetView> {

    // Special-case the Jupyter base and controls packages. If we have just a
    // plain version, with no indication of the compatible range, prepend a ^ to
    // get all compatible versions. We may eventually apply this logic to all
    // widget modules. See issues #2006 and #2017 for more discussion.
    if ((moduleName === '@jupyter-widgets/base'
         || moduleName === '@jupyter-widgets/controls')
        && valid(moduleVersion)) {
      moduleVersion = `^${moduleVersion}`;
    }

    const mod = this._registry.get(moduleName, moduleVersion);
    if (!mod) {
      throw new Error(`Module ${moduleName}, semver range ${moduleVersion} is not registered as a widget module`);
    }
    let module: ExportMap;
    if (typeof mod === 'function') {
      module = await mod();
    } else {
      module = await mod;
    }
    const cls: any = module[className];
    if (!cls) {
      throw new Error(`Class ${className} not found in module ${moduleName}`);
    }
    return cls;
  }

  get context() {
    return this._context;
  }

  get rendermime() {
    return this._rendermime;
  }

  register(data: IWidgetRegistryData) {
    this._registry.set(data.name, data.version, data.exports);
  }

  /**
   * Get a model
   *
   * #### Notes
   * Unlike super.get_model(), this implementation always returns a promise and
   * never returns undefined. The promise will reject if the model is not found.
   */
  async get_model(model_id: string): Promise<WidgetModel> {
    try {
      // Resolving the restored promise may call get_model to unpack widget
      // references, so we must first see if we can return right away.
      const modelPromise = super.get_model(model_id);
      if (modelPromise === undefined) {
        throw new Error('widget model not found');
      }
      return await modelPromise;
    } catch (err) {
      // If we are currently restoring, then don't block on the restored promise.
      if (this._restoring) {
        throw err;
      }

      // Wait until the widget state is restored, then try one more time.
      await this._restored;
      const modelPromise = super.get_model(model_id);
      if (modelPromise === undefined) {
        throw new Error('widget model not found');
      }
      return await modelPromise;
    }
  }

  private _handleCommOpen: (comm: Kernel.IComm, msg: KernelMessage.ICommOpenMsg) => Promise<void>;
  private _context: DocumentRegistry.IContext<INotebookModel>;
  private _registry: SemVerCache<ExportData> = new SemVerCache<ExportData>();
  private _rendermime: RenderMimeRegistry;

  _commRegistration: IDisposable;
  private _restored: Promise<void>;
  private _restoring: boolean;
}


namespace Private {

  /**
   * Data promised when a comm info request resolves.
   */
  export
  interface ICommUpdateData {
    comm: IClassicComm;
    msg: KernelMessage.ICommMsg;
  }
}
