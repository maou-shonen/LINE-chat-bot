var default_expiredays = 1000 * 60 * 60 * 24 * 7

axios.defaults.baseURL = 'http://line.maou.pw/api'

var vm = new Vue({
    el: '#app',
    data() {
        return {
            index: '關鍵字',
            tableData: [],

            keyword: {
                mode: '群組',
                search: '',
                search_list: [],
                dialog: {
                    visible: false,
                    type: '',
                    title: '',
                    keyword: '',
                    reply: '',
                    old_keyword: '',
                },
                checkbox: {
                    visible: false,
                    type: '',
                    title: '',
                    index: 0,
                    row: null,
                },
            },

            pagination: { //底部分頁
                size: 20,
                total: 0,
                page: 1,
            },

            options: [
                {option: 'a', value: '111'},
                {option: 'b', value: '222'},
            ],
        }
    },

    mounted() {
        //window.location.replace("http://google.com")
        this.keyword_get()
    },

    methods: {
        keyword_get() {
            let self = this
            axios.post('/keyword/get', {
                mode: this.keyword.mode,
                page:  this.pagination.page,
                length: this.pagination.size,
                search: this.keyword.search,
            }).then(function (response) {
                self.tableData = []
                self.keyword.search_list = []
                response.data.result.forEach(element => {
                    //if (self.tableData.length <= self.pagination.size) {
                        self.tableData.push(element)
                    //}
                    self.keyword.search_list.push({value: element.keyword})
                })
                self.pagination.total = response.data.total
            })
        },

        keyword_search(queryString, cb) {
            this.keyword_get()
            cb(this.keyword.search_list)
        },

        keyword_dialog(type, index, row) {
            this.keyword.dialog.type = type
            switch(type) {
                case 'new':
                    this.keyword.dialog.title = '新增關鍵字'
                    this.keyword.dialog.keyword = ''
                    this.keyword.dialog.reply = ''
                    break
                case 'edit':
                    this.keyword.dialog.title = '修改關鍵字'
                    this.keyword.dialog.keyword = row.keyword
                    this.keyword.dialog.reply = row.reply
                    this.keyword.dialog.old_keyword = row.keyword
                    break
            }
            this.keyword.dialog.visible = true
        },

        keyword_dialog_click() {
            let self = this
            switch(this.keyword.dialog.type) {
                case 'new':
                    axios.post('/keyword/add', {
                        keyword: this.keyword.dialog.keyword,
                        reply: this.keyword.dialog.reply,
                    })
                    this.$message({type: 'success', message: '新增' + this.keyword.dialog.keyword +'完成'})
                    break
                case 'edit':
                    axios.post('/keyword/edit', {
                        old_keyword: this.keyword.dialog.old_keyword,
                        keyword: this.keyword.dialog.keyword,
                        reply: this.keyword.dialog.reply,
                    })
                    this.$message({type: 'success', message: '修改' + this.keyword.dialog.keyword + '完成'})
                    break
            }
            this.keyword.dialog.visible = false
            this.keyword_get()
        },

        keyword_checkbox(type, index, row) {
            this.keyword.checkbox.type = type
            switch(type) {
                case 'delete':
                    this.keyword.checkbox.title = '確定刪除 ' + row.keyword
                    this.keyword.checkbox.index = index
                    this.keyword.checkbox.row = row
                    break
            }
            this.keyword.checkbox.visible = true
        },

        keyword_checkbox_click() {
            let self = this
            switch(this.keyword.checkbox.type) {
                case 'delete':
                    axios.post('/keyword/delete', {
                        keyword: this.keyword.checkbox.row.keyword,
                    })
                    this.$message({type: 'success', message: '刪除 ' + this.keyword.checkbox.row.keyword + ' 完成'})
                    break
            }
            this.keyword.checkbox.visible = false
            this.keyword_get()
        },
    },
})
  

function refresh() {
    vm.keyword_get()
}
//setTimeout('refresh()',1000); //指定1秒刷新一次
