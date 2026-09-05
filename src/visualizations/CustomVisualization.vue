<template lang="pug">
  div.custom-visualization
    div.aw-loading(v-if="loading") Loading…
    iframe(
      :src="src"
      frameborder="0"
      loading="lazy"
      @load="loading = false"
      :title="title || visname"
    )
</template>

<script lang="js">
import moment from 'moment';
import { useActivityStore } from '~/stores/activity';

export default {
  name: 'aw-custom-watcher',
  props: {
    visname: String,
    title: String,
  },
  data() {
    return { loading: true };
  },
  computed: {
    src: function () {
      const options = useActivityStore().query_options;
      const start = options.timeperiod.start;
      const end = moment(start).add(...options.timeperiod.length).toISOString();
      const urlParams = new URLSearchParams({
        hostname: options.host,
        start,
        end,
        title: this.title,
      });
      let _origin = document.location.origin;
      if(document.location.port == "27180") {
        // NOTE: document.location.origin won't work when running aw-webui in dev mode
        _origin = "http://localhost:5666"
      }
      return _origin + '/pages/' + this.visname + '/?' + urlParams.toString();
    },
  },
};
</script>
<style scoped>
.custom-visualization {
  position: relative;
  min-height: 360px;
}
.custom-visualization iframe {
  display: block;
  width: 100%;
  min-height: 360px;
  border: 0;
}
.aw-loading {
  position: absolute;
  inset: 1rem;
  display: grid;
  place-items: center;
  color: #8a8f98;
}
</style>
